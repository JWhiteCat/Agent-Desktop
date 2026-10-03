import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupAcpUsagePreload } from '../src/main/acp-usage'
import { claudeLogin, resolveClaude, resolveClaudeAcpEntry, spawnClaudeAcp } from '../src/main/claude'
import { killTree, resolveCli, runCliOnce } from '../src/main/cli'
import { cliEnvironment, cliSearchDirectories, spawnCliProcess } from '../src/main/cli-runtime'
import { resolveCodex, resolveCodexAcpEntry, spawnCodexAcp } from '../src/main/codex'

const children: ChildProcess[] = []
let root: string
let home: string

function executable(file: string, content = '#!/bin/sh\nexit 0\n', mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, { mode })
  fs.chmodSync(file, mode)
  return file
}

async function output(child: ChildProcess): Promise<string> {
  children.push(child)
  let text = ''
  let errors = ''
  child.stdout?.on('data', (chunk) => { text += chunk.toString() })
  child.stderr?.on('data', (chunk) => { errors += chunk.toString() })
  const [code] = await once(child, 'close')
  expect(code, errors).toBe(0)
  return text.trim()
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-cli-runtime-'))
  home = path.join(root, 'home')
  fs.mkdirSync(home)
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.stubEnv('PATH', path.join(root, 'empty-path'))
  for (const key of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'NVM_BIN', 'PNPM_HOME', 'VOLTA_HOME', 'HOMEBREW_PREFIX']) vi.stubEnv(key, undefined)
})

afterEach(async () => {
  cleanupAcpUsagePreload()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const child of children.splice(0)) {
    // Fixture cleanup only: never target an inherited shell or a real CLI.
    if (child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* fixture already gone */ }
    }
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGKILL')
      await closed
    }
  }
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('agent-desktop-cli-runtime-')) {
    throw new Error(`Unexpected fixture directory: ${root}`)
  }
  fs.rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('POSIX desktop CLI discovery and environment', () => {
  it('preserves inherited PATH precedence, removes duplicates and adds Linux desktop locations', () => {
    const selected = path.join(root, 'selected node', 'bin')
    const prefix = path.join(root, 'custom npm')
    vi.stubEnv('PATH', [selected, '', selected].join(path.delimiter))
    vi.stubEnv('NPM_CONFIG_PREFIX', prefix)
    vi.stubEnv('NVM_BIN', path.join(root, 'nvm', 'bin'))
    vi.stubEnv('HOMEBREW_PREFIX', path.join(root, 'brew'))
    const directories = cliSearchDirectories()
    expect(directories[0]).toBe(selected)
    expect(directories.filter((dir) => dir === selected)).toHaveLength(1)
    expect(directories).not.toContain('')
    expect(directories).toEqual(expect.arrayContaining([
      path.join(prefix, 'bin'), path.join(root, 'nvm', 'bin'), path.join(root, 'brew', 'bin'),
      path.join(home, '.local', 'bin'), path.join(home, 'bin'), path.join(home, '.npm-global', 'bin'),
      path.join(home, '.linuxbrew', 'bin'), '/home/linuxbrew/.linuxbrew/bin', '/usr/bin', '/bin'
    ]))
    const previous = process.env.NO_COLOR
    const env = cliEnvironment({ NO_COLOR: '1' })
    expect(env.PATH?.split(path.delimiter)).toEqual(directories)
    expect(env.NO_COLOR).toBe('1')
    expect(process.env.NO_COLOR).toBe(previous)
  })

  it.each([
    ['Cursor', 'agent', resolveCli, 'command'],
    ['Codex', 'codex', resolveCodex, 'codexPath'],
    ['Claude', 'claude', resolveClaude, 'claudePath']
  ] as const)('resolves %s executable files, quoted paths, home shorthand and prefix directories', (_provider, name, resolve, field) => {
    const prefix = path.join(home, 'my cli')
    const file = executable(path.join(prefix, 'bin', name))
    for (const input of [file, `  "${file}"  `, `'${file}'`, `~/my cli/bin/${name}`, prefix, path.join(prefix, 'bin')]) {
      expect(resolve(input)).toHaveProperty(field, file)
    }
    expect(resolve(path.join(root, 'missing'))).toBeUndefined()
    const invalid = executable(path.join(root, 'not executable', name), '', 0o644)
    expect(resolve(invalid)).toBeUndefined()
    fs.mkdirSync(path.join(root, 'directory', name), { recursive: true })
    expect(resolve(path.join(root, 'directory', name))).toBeUndefined()
  })

  it('does not introduce current-directory PATH entries for blank version-manager settings', () => {
    const directories = cliSearchDirectories({ PATH: '', NPM_CONFIG_PREFIX: ' ', NVM_BIN: ' ', PNPM_HOME: ' ', VOLTA_HOME: ' ', HOMEBREW_PREFIX: ' ' })
    expect(directories.every((dir) => path.isAbsolute(dir))).toBe(true)
  })

  it.each([
    ['agent', resolveCli, 'command'],
    ['codex', resolveCodex, 'codexPath'],
    ['claude', resolveClaude, 'claudePath']
  ] as const)('skips a non-executable %s and finds the next PATH entry without requiring which', (name, resolve, field) => {
    const first = executable(path.join(root, 'first', name), '', 0o644)
    const second = executable(path.join(root, 'second', name))
    vi.stubEnv('PATH', [path.dirname(first), path.dirname(second)].join(path.delimiter))
    expect(resolve('')).toHaveProperty(field, second)
  })

  it.each([
    ['agent', resolveCli, 'command'],
    ['codex', resolveCodex, 'codexPath'],
    ['claude', resolveClaude, 'claudePath']
  ] as const)('finds %s in a configured npm prefix missing from the desktop PATH', (name, resolve, field) => {
    const prefix = path.join(root, 'npm installation')
    const file = executable(path.join(prefix, 'bin', name))
    vi.stubEnv('npm_config_prefix', prefix)
    expect(resolve('')).toHaveProperty(field, file)
  })

  it('finds a user Linuxbrew executable without terminal shell initialization', () => {
    const file = executable(path.join(home, '.linuxbrew', 'bin', 'agent'))
    expect(resolveCli('')?.command).toBe(file)
  })

  it('runs a selected shebang CLI with its colocated node runtime and preserves literal arguments', async () => {
    const directory = path.join(root, 'custom node & tools', 'bin')
    fs.mkdirSync(directory, { recursive: true })
    fs.symlinkSync(process.execPath, path.join(directory, 'node'))
    const script = executable(path.join(directory, 'agent'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n')
    const cli = resolveCli(script)!
    const args = ['--version', 'spaces & pipes | "quotes"', 'new\nline']
    const result = await runCliOnce(cli, args, 10_000, false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(args)
  })

  it.each(['Codex', 'Claude'] as const)('launches %s adapters through the runtime with the selected executable environment', async (provider) => {
    const script = executable(path.join(root, 'app.asar.unpacked', 'adapter.cjs'), `
      console.log(JSON.stringify({ cwd: process.cwd(), node: process.env.ELECTRON_RUN_AS_NODE,
        selected: process.env.${provider === 'Codex' ? 'CODEX_PATH' : 'CLAUDE_CODE_EXECUTABLE'}, path: process.env.PATH }))
    `)
    const selected = executable(path.join(root, 'selected tools', provider.toLowerCase()))
    const base = { acpEntry: script, bundled: false, display: selected }
    const child = provider === 'Codex'
      ? spawnCodexAcp({ ...base, codexPath: selected }, home, '')
      : spawnClaudeAcp({ ...base, claudePath: selected }, home, '')
    const result = JSON.parse(await output(child))
    expect(result).toMatchObject({ cwd: home, node: '1', selected })
    expect(result.path.split(path.delimiter)[0]).toBe(path.dirname(selected))
  })

  it('passes the selected Claude executable to the login adapter rather than the bundled fallback', async () => {
    const script = executable(path.join(root, 'login-fixture.cjs'), 'console.log(process.env.CLAUDE_CODE_EXECUTABLE)\n')
    const selected = executable(path.join(root, 'my claude', 'claude'))
    expect(await claudeLogin({ acpEntry: script, bundled: false, display: selected, claudePath: selected })).toBe(selected)
  })

  it('prefers unpacked adapter entrypoints in a packaged Linux application', () => {
    const resources = path.join(root, 'resources')
    const codex = executable(path.join(resources, 'app.asar.unpacked', 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js'))
    const claude = executable(path.join(resources, 'app.asar.unpacked', 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js'))
    const descriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources })
    try {
      expect(resolveCodexAcpEntry()).toBe(codex)
      expect(resolveClaudeAcpEntry()).toBe(claude)
    } finally {
      if (descriptor) Object.defineProperty(process, 'resourcesPath', descriptor)
      else delete (process as Partial<NodeJS.Process>).resourcesPath
    }
  })
})

describe.skipIf(process.platform === 'win32')('POSIX CLI cancellation', () => {
  it('terminates a CLI child and its subprocesses, including a tool that ignores SIGTERM', async () => {
    const tool = executable(path.join(root, 'tool.cjs'), `
      process.on('SIGTERM', () => {})
      process.stdout.write('ready\\n')
      setInterval(() => {}, 1000)
    `)
    const adapter = executable(path.join(root, 'adapter.cjs'), `
      const { spawn } = require('node:child_process')
      spawn(process.execPath, [${JSON.stringify(tool)}], { stdio: ['ignore', 'inherit', 'inherit'] })
      setInterval(() => {}, 1000)
    `)
    const child = spawnCliProcess(process.execPath, [adapter], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    await once(child.stdout!, 'data')
    const closed = once(child, 'close')
    const exited = once(child, 'exit')
    killTree(child)
    killTree(child) // Repeated cancel must not schedule duplicate escalation.
    await exited
    expect(child.signalCode).toBe('SIGTERM')
    // close waits for the descendant's inherited pipe, even after the adapter exits.
    await closed
  }, 10_000)

  it('never signals the caller process group for an ordinary, non-detached child', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    children.push(child)
    const closed = once(child, 'close')
    killTree(child)
    await closed
    expect(child.signalCode).toBe('SIGTERM')
  })
})
