import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), killTree: vi.fn(), cursor: vi.fn(), codex: vi.fn(), claude: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/main/cli', () => ({ resolveCli: mocks.cursor, killTree: mocks.killTree, stripAnsi: (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '') }))
vi.mock('../src/main/codex', () => ({ resolveCodex: mocks.codex }))
vi.mock('../src/main/claude', () => ({ resolveClaude: mocks.claude }))

import { updateClaude, updateCodex, updateCursor } from '../src/main/cli-update'

describe('CLI updates', () => {
  let root: string
  let npmScript: string
  let acpEntry: string

  function write(file: string, text = ''): string {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
  }

  function installedCodex(prefix: string, placement: 'nested' | 'hoisted' | 'legacy' = 'nested'): string {
    const modules = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules')
    const main = path.join(modules, '@openai', 'codex')
    write(path.join(main, 'package.json'), JSON.stringify({ name: '@openai/codex' }))
    const vendor = placement === 'legacy' ? main : path.join(placement === 'nested' ? path.join(main, 'node_modules') : modules, '@openai', `codex-${process.platform}-${process.arch}`)
    return write(path.join(vendor, 'vendor', 'target', 'bin', 'codex.exe'))
  }

  function childResult(code: number | null, output = '', error?: Error) {
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(output))
        if (error) child.emit('error', error)
        child.emit('close', code)
      })
      return child
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-cli-update-'))
    const npmBin = path.join(root, 'node installation')
    npmScript = write(path.join(npmBin, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    vi.stubEnv('PATH', npmBin)
    acpEntry = path.join(root, 'app', 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js')
    childResult(0, 'already current')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    const resolved = path.resolve(root)
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('agent-desktop-cli-update-')) {
      throw new Error(`Unexpected fixture directory: ${resolved}`)
    }
    fs.rmSync(resolved, { recursive: true, force: true })
  })

  it('updates exactly the resolved Cursor command and preserves its prefix arguments', async () => {
    const node = path.join(root, 'Cursor agent', 'node.exe')
    const script = path.join(root, 'Cursor agent', 'index.js')
    mocks.cursor.mockReturnValue({ command: node, prefixArgs: [script], display: script })
    expect(await updateCursor('custom cursor')).toContain('Cursor CLI 更新完成')
    expect(mocks.cursor).toHaveBeenCalledWith('custom cursor')
    expect(mocks.spawn).toHaveBeenCalledWith(node, [script, 'update'], expect.objectContaining({ shell: false, windowsHide: true, env: expect.objectContaining({ CURSOR_INVOKED_AS: 'agent' }) }))
  })

  it.each(['nested', 'hoisted', 'legacy'] as const)('updates the selected %s npm Codex package in its own prefix', async (placement) => {
    const prefix = path.join(root, 'custom npm & path')
    const executable = installedCodex(prefix, placement)
    mocks.codex.mockReturnValue({ codexPath: executable, bundled: false, acpEntry })
    await updateCodex('custom codex')
    expect(mocks.codex).toHaveBeenCalledWith('custom codex')
    expect(mocks.spawn).toHaveBeenCalledWith(process.execPath, [npmScript, 'install', '--global', '--prefix', prefix, '@openai/codex@latest'], expect.objectContaining({ shell: false, env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }) }))
  })

  it('refuses bundled binaries even when explicitly selected as a custom path', async () => {
    const executable = write(path.join(root, 'app', 'node_modules', '@openai', 'codex', 'vendor', 'codex.exe'))
    mocks.codex.mockReturnValue({ codexPath: executable, bundled: false, acpEntry })
    await expect(updateCodex(executable)).rejects.toThrow('内置 Codex')
    mocks.claude.mockReturnValue({ bundled: true, acpEntry })
    await expect(updateClaude('')).rejects.toThrow('内置 Claude Code')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('uses npm from the selected Linux prefix even when it is absent from PATH', async () => {
    const prefix = path.join(root, 'custom node installation')
    const executable = installedCodex(prefix)
    const selectedNpm = write(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    mocks.codex.mockReturnValue({ codexPath: executable, bundled: false, acpEntry })
    await updateCodex(executable)
    expect(mocks.spawn).toHaveBeenCalledWith(process.execPath,
      [selectedNpm, 'install', '--global', '--prefix', prefix, '@openai/codex@latest'],
      expect.objectContaining({ detached: true, shell: false }))
    expect(mocks.spawn.mock.calls[0][2].env.PATH.split(path.delimiter)[0]).toBe(path.join(prefix, 'bin'))
  })

  it('does not update an unrelated npm installation next to a custom Codex wrapper', async () => {
    const prefix = path.join(root, 'npm')
    installedCodex(prefix)
    const wrapper = write(path.join(prefix, 'codex-work.cmd'))
    mocks.codex.mockReturnValue({ codexPath: wrapper, bundled: false, acpEntry })
    await expect(updateCodex(wrapper)).rejects.toThrow('无法识别')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('reports unsupported standalone Codex installations without spawning another CLI', async () => {
    const executable = write(path.join(root, 'standalone', 'codex.exe'))
    mocks.codex.mockReturnValue({ codexPath: executable, bundled: false, acpEntry })
    await expect(updateCodex(executable)).rejects.toThrow('原安装工具')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('does not mistake another package binary for a neighboring Codex installation', async () => {
    const prefix = path.join(root, 'npm')
    installedCodex(prefix)
    const executable = write(path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', 'custom-wrapper', 'codex.exe'))
    mocks.codex.mockReturnValue({ codexPath: executable, bundled: false, acpEntry })
    await expect(updateCodex(executable)).rejects.toThrow('无法识别')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('updates the selected native Claude executable', async () => {
    const executable = write(path.join(root, 'Claude & CLI', 'claude.exe'))
    mocks.claude.mockReturnValue({ claudePath: executable, bundled: false, acpEntry })
    await updateClaude(executable)
    expect(mocks.spawn).toHaveBeenCalledWith(executable, ['update'], expect.objectContaining({ shell: false }))
  })

  it.skipIf(process.platform !== 'win32')('updates a selected npm Claude shim without launching cmd.exe', async () => {
    const prefix = path.join(root, 'npm & custom')
    write(path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code' }))
    const executable = write(path.join(prefix, 'claude.cmd'))
    mocks.claude.mockReturnValue({ claudePath: executable, bundled: false, acpEntry })
    await updateClaude(executable)
    expect(mocks.spawn).toHaveBeenCalledWith(process.execPath, [npmScript, 'install', '--global', '--prefix', prefix, '@anthropic-ai/claude-code@latest'], expect.objectContaining({ shell: false }))
  })

  it.skipIf(process.platform === 'win32')('updates the owning Homebrew installation', async () => {
    const executable = write(path.join(root, 'homebrew', 'Caskroom', 'codex', '1.0', 'codex'))
    const brew = write(path.join(root, 'homebrew', 'bin', 'brew'))
    mocks.codex.mockReturnValue({ codexPath: executable, bundled: false, acpEntry })
    await updateCodex(executable)
    expect(mocks.spawn).toHaveBeenCalledWith(brew, ['upgrade', '--cask', 'codex'], expect.objectContaining({ shell: false }))
  })

  it.skipIf(process.platform === 'win32')('updates a Linuxbrew formula through its owning prefix', async () => {
    const executable = write(path.join(root, '.linuxbrew', 'Cellar', 'codex', '1.0', 'bin', 'codex'))
    const brew = write(path.join(root, '.linuxbrew', 'bin', 'brew'))
    const link = path.join(root, '.linuxbrew', 'bin', 'codex')
    fs.symlinkSync(executable, link)
    mocks.codex.mockReturnValue({ codexPath: link, bundled: false, acpEntry })
    await updateCodex(link)
    expect(mocks.spawn).toHaveBeenCalledWith(brew, ['upgrade', 'codex'], expect.objectContaining({ detached: true, shell: false }))
  })

  it('rejects nonzero exits with CLI output', async () => {
    mocks.cursor.mockReturnValue({ command: 'agent', prefixArgs: [] })
    childResult(1, '\u001b[31mnetwork unavailable\u001b[0m')
    await expect(updateCursor('')).rejects.toThrow('更新失败（退出码 1）。\nnetwork unavailable')
  })

  it('rejects spawn failures instead of reporting success after close', async () => {
    mocks.cursor.mockReturnValue({ command: 'agent', prefixArgs: [] })
    childResult(-1, '', new Error('ENOENT'))
    await expect(updateCursor('')).rejects.toThrow('更新失败：ENOENT')
  })

  it('waits for a stalled update to stop before releasing the update promise', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
    mocks.spawn.mockImplementation(() => child)
    mocks.cursor.mockReturnValue({ command: 'agent', prefixArgs: [] })
    let settled = false
    const result = updateCursor('').finally(() => { settled = true })
    const assertion = expect(result).rejects.toThrow('更新超时')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(mocks.killTree).toHaveBeenCalledWith(child)
    expect(settled).toBe(false)
    child.emit('close', 0)
    await assertion
    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports the timeout if process termination never emits close', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
    mocks.spawn.mockImplementation(() => child)
    mocks.cursor.mockReturnValue({ command: 'agent', prefixArgs: [] })
    const assertion = expect(updateCursor('')).rejects.toThrow('更新超时')
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 5_000)
    await assertion
    expect(mocks.killTree).toHaveBeenCalledWith(child)
  })
})
