import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { builtinModules, createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { build } from 'vite'
import type { ToolbarCommandPayload } from '../src/main/toolbar-command-payload'
import { terminalLaunch } from '../src/main/toolbar-terminal'

vi.mock('electron', () => ({ app: {} }))

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent toolbar runner '))
const runner = path.join(directory, 'toolbar-runner.cjs')
const printer = path.join(directory, 'print args.cjs')
beforeAll(async () => {
  await build({ configFile: false, publicDir: false, logLevel: 'silent', build: {
    target: 'node22', outDir: directory, emptyOutDir: false,
    lib: { entry: path.resolve('src/main/toolbar-runner.ts'), formats: ['cjs'], fileName: () => 'toolbar-runner.cjs' },
    rollupOptions: { external: (id) => id.startsWith('node:') || builtinModules.includes(id) }
  } })
  fs.writeFileSync(printer, 'console.log("ARGV:"+JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),electronNode:process.env.ELECTRON_RUN_AS_NODE}));')
})
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

async function run(program: string, args: string[], executable = process.execPath, extra: Partial<ToolbarCommandPayload> = {}): Promise<{ output: string; code: number | null; status: unknown }> {
  const launch = fs.mkdtempSync(path.join(directory, 'payload-'))
  const payload: ToolbarCommandPayload = { program, args, cwd: directory, messages: { failed: 'FAILED', finished: 'EXIT', close: 'ENTER_TO_CLOSE' }, ...extra }
  const file = path.join(launch, 'payload.json')
  fs.writeFileSync(file, JSON.stringify(payload))
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [runner, file], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let replied = false
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Runner timed out: ${output}`)) }, 10_000)
    const append = (data: Buffer) => {
      output += data.toString()
      if (output.includes('ENTER_TO_CLOSE') && !replied) { replied = true; child.stdin.end('\n') }
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ output, code, status: JSON.parse(fs.readFileSync(path.join(launch, 'status.json'), 'utf8')) })
    })
  })
}

describe('standalone toolbar runner', () => {
  it.skipIf(process.platform === 'win32')('preserves the desktop PATH for commands in a separately opened terminal', async () => {
    const selected = path.join(directory, 'selected node', 'bin')
    const result = await run(process.execPath, ['-e', 'console.log("PATH:" + process.env.PATH)'], process.execPath, { path: selected })
    expect(result.code).toBe(0)
    expect(result.output).toContain(`PATH:${selected}`)
  })
  const args = ['plain', '', 'with spaces', '中文路径', 'a"quote', 'a\\"quote', 'C:\\tail\\', '&|<>^%!()', '%PATH%', '!EXPAND!', '$(command)', '{cwd}']

  it('preserves literal arguments and cwd through a real native child and removes Electron launch mode', async () => {
    const result = await run(process.execPath, [printer, ...args])
    expect(result.status).toEqual({ kind: 'started' })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.output.match(/ARGV:(.+)/)![1])).toEqual({ args, cwd: directory })
    expect(result.output).toContain('EXIT: 0')
    expect(result.output).toContain('ENTER_TO_CLOSE')
  })

  it.runIf(process.platform === 'win32')('preserves arguments through a Windows npm-style cmd shim', async () => {
    const shim = path.join(directory, 'print args.cmd')
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${printer}" %*\r\n`)
    const result = await run(shim, args)
    expect(result.status).toEqual({ kind: 'started' })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.output.match(/ARGV:(.+)/)![1])).toEqual({ args, cwd: directory })
  })

  it('keeps failed command output and the exit code visible until Enter', async () => {
    const result = await run(process.execPath, ['-e', 'console.error("visible failure");process.exitCode=7'])
    expect(result.code).toBe(7)
    expect(result.output).toContain('visible failure')
    expect(result.output).toContain('EXIT: 7')
    expect(result.output).toContain('ENTER_TO_CLOSE')
  })

  it('acknowledges a spawn error and retains its details in the terminal', async () => {
    const result = await run(path.join(directory, 'missing.exe'), [])
    expect(result.status).toEqual({ kind: 'error', message: expect.stringContaining('ENOENT') })
    expect(result.code).toBe(1)
    expect(result.output).toContain('FAILED:')
    expect(result.output).toContain('ENTER_TO_CLOSE')
  })

  it('has no external runtime package imports', () => {
    const source = fs.readFileSync(runner, 'utf8')
    expect(source).not.toMatch(/require\(["']cross-spawn["']\)/)
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
    expect(pkg.build.extraResources).toContainEqual({ from: 'out/main/toolbar-runner.cjs', to: 'toolbar-runner.cjs' })
  })

  // This opt-in check opens one real console briefly, verifies its buffers, and queues Enter to close it.
  it.runIf(process.platform === 'win32' && process.env.AGENT_DESKTOP_CONSOLE_SMOKE === '1')('uses a real new Windows console with visible output and working Enter input', async () => {
    const launchDirectory = fs.mkdtempSync(path.join(directory, 'console-'))
    const resultFile = path.join(launchDirectory, 'result.json')
    const payloadFile = path.join(launchDirectory, 'payload.json')
    const powershell = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const payload: ToolbarCommandPayload = {
      program: powershell, args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('test/helpers/toolbar-console-smoke.ps1'), resultFile],
      cwd: directory, messages: { failed: 'FAILED', finished: 'EXIT', close: 'ENTER_TO_CLOSE' }
    }
    fs.writeFileSync(payloadFile, JSON.stringify(payload))
    const electron = process.env.AGENT_DESKTOP_CONSOLE_EXECUTABLE || createRequire(import.meta.url)('electron') as string
    const consoleRunner = process.env.AGENT_DESKTOP_CONSOLE_RUNNER || runner
    const launch = terminalLaunch('win32', electron, consoleRunner, payloadFile)
    let diagnostic = ''
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, { cwd: directory, detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', (data) => { diagnostic += data.toString() })
      child.stderr.on('data', (data) => { diagnostic += data.toString() })
      const timer = setTimeout(() => { child.kill(); reject(new Error('Console smoke timed out')) }, 15_000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('close', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
    })
    if (!fs.existsSync(resultFile)) {
      const statusFile = path.join(launchDirectory, 'status.json')
      throw new Error(`Console exited ${code} without result; status=${fs.existsSync(statusFile) ? fs.readFileSync(statusFile, 'utf8') : 'missing'}; ${diagnostic}`)
    }
    expect(code).toBe(0)
    expect(JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, ''))).toEqual({ stdinConsole: true, stdoutConsole: true, visibleOutput: true, enterQueued: true })
    expect(JSON.parse(fs.readFileSync(path.join(launchDirectory, 'status.json'), 'utf8'))).toEqual({ kind: 'started' })
  }, 20_000)
})
