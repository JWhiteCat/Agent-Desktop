import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findTerminalExecutable, launchToolbarCommand, quotePosix, startTerminal, terminalLaunch, waitForTerminalStatus } from '../src/main/toolbar-terminal'
import { setLanguage } from '../src/shared/i18n'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), app: { isPackaged: false } }))
vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

const directories: string[] = []
function temporary() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-toolbar-test-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
  vi.resetAllMocks()
  setLanguage('system', 'zh-CN')
})

describe('terminal launchers', () => {
  it('transports only application paths through an encoded PowerShell launcher', () => {
    const result = terminalLaunch('win32', "D:\\应用's & Tools\\app.exe", 'D:\\app\\runner.cjs', 'D:\\temp\\payload.json')
    expect(result.command).toMatch(/powershell\.exe$/i)
    const bootstrap = Buffer.from(result.args.at(-1)!, 'base64').toString('utf16le')
    expect(bootstrap).toContain('-WindowStyle Normal')
    const inner = bootstrap.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1]
    const script = Buffer.from(inner, 'base64').toString('utf16le')
    const encoded = script.match(/FromBase64String\('([^']+)'\)/)![1]
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toEqual({
      executable: "D:\\应用's & Tools\\app.exe", runner: 'D:\\app\\runner.cjs', payload: 'D:\\temp\\payload.json'
    })
    expect(script).toContain('Start-Process')
    expect(script).toContain('-NoNewWindow -Wait')
    expect(result.args).not.toContain('-NoExit')
  })

  it('escapes macOS application paths as shell literals inside an AppleScript string', () => {
    const result = terminalLaunch('darwin', "/Applications/Agent's Desktop.app/app", '/tmp/runner.cjs', '/tmp/a "b"/payload.json')
    expect(result.command).toBe('/usr/bin/osascript')
    const quoted = result.args[1].match(/do script (.+)\nend tell/)![1]
    const command = JSON.parse(quoted)
    expect(command).toBe(`exec env 'ELECTRON_RUN_AS_NODE=1' ${quotePosix("/Applications/Agent's Desktop.app/app")} '/tmp/runner.cjs' '/tmp/a "b"/payload.json'`)
  })

  it.each([
    ['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--wait', '--']],
    ['konsole', ['--separate', '-e']], ['xterm', ['-e']]
  ])('supports %s without concatenating a command string', (available, prefix) => {
    const find = vi.fn((name: string) => name === available ? `/bin/${name}` : undefined)
    expect(terminalLaunch('linux', '/app name', '/runner', '/payload', find)).toEqual({
      command: `/bin/${available}`, args: [...prefix, '/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', '/app name', '/runner', '/payload']
    })
  })

  it('reports a missing Linux terminal', () => {
    expect(() => terminalLaunch('linux', '/app', '/runner', '/payload', () => undefined)).toThrow('未找到可用终端')
  })

  it('resolves a real executable from PATH without searching the working directory', () => {
    const directory = temporary()
    const name = process.platform === 'win32' ? 'some-tool.CMD' : 'some-tool'
    const file = path.join(directory, name)
    fs.writeFileSync(file, '', { mode: 0o755 })
    expect(findTerminalExecutable('some-tool', { Path: directory, PATHEXT: '.EXE;.CMD' })).toBe(file)
    expect(findTerminalExecutable('some-missing-tool', { PATH: '' })).toBeUndefined()
  })
})

describe('terminal acknowledgement', () => {
  it('waits for macOS automation permission and reports denial without retrying', async () => {
    setLanguage('zh-CN')
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), unref: vi.fn() })
    mocks.spawn.mockReturnValue(child)
    const started = startTerminal(terminalLaunch('darwin', '/app', '/runner', '/payload'), '/tmp', {}, 'darwin')
    child.emit('spawn')
    child.stderr.emit('data', Buffer.from('Not authorized to send Apple events to Terminal. (-1743)'))
    child.emit('close', 1)
    await expect(started).rejects.toThrow('自动化中允许 Agent Desktop 控制 Terminal')
    expect(mocks.spawn).toHaveBeenCalledOnce()
  })

  it('accepts macOS Terminal only after osascript succeeds', async () => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), unref: vi.fn() })
    mocks.spawn.mockReturnValue(child)
    const started = startTerminal(terminalLaunch('darwin', '/app', '/runner', '/payload'), '/tmp', {}, 'darwin')
    const done = vi.fn()
    void started.then(done)
    child.emit('spawn')
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    child.emit('close', 0)
    await started
    expect(done).toHaveBeenCalledOnce()
  })

  it.each([{ kind: 'started' }, { kind: 'error', message: 'Permission denied' }])('reads %j from the runner', async (status) => {
    const directory = temporary()
    fs.writeFileSync(path.join(directory, 'status.json'), JSON.stringify(status))
    await expect(waitForTerminalStatus(directory)).resolves.toEqual(status)
  })

  it('reports timeout without retrying a command', async () => {
    const directory = temporary()
    await expect(waitForTerminalStatus(directory, 10, 2)).rejects.toThrow('终端启动确认超时')
  })

  it('rejects an invalid working directory before opening any terminal', async () => {
    mocks.spawn.mockClear()
    await expect(launchToolbarCommand({ program: process.execPath, args: [], cwd: path.join(temporary(), 'missing') })).rejects.toThrow('工作目录不存在')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
