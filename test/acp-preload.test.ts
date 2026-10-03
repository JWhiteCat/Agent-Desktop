import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acpUsagePreloadSource, cleanupAcpUsagePreload, installAcpUsagePreload } from '../src/main/acp-usage'

let root: string
let originalTemp: string

beforeEach(() => {
  cleanupAcpUsagePreload()
  originalTemp = os.tmpdir()
  root = fs.mkdtempSync(path.join(originalTemp, 'agent-desktop-preload-test-'))
  const temporary = path.join(root, 'temporary directory with spaces')
  fs.mkdirSync(temporary)
  vi.spyOn(os, 'tmpdir').mockReturnValue(temporary)
})

afterEach(() => {
  cleanupAcpUsagePreload()
  vi.restoreAllMocks()
  if (path.dirname(root) !== path.resolve(originalTemp) || !path.basename(root).startsWith('agent-desktop-preload-test-')) {
    throw new Error(`Unexpected fixture directory: ${root}`)
  }
  fs.rmSync(root, { recursive: true, force: true })
})

function preloadPath(env: NodeJS.ProcessEnv): string {
  const match = env.NODE_OPTIONS?.match(/--require "([^"]+)"$/)
  expect(match).not.toBeNull()
  return match![1]
}

describe('private executable ACP preload', () => {
  it('uses a private random directory and owner-only file, and reuses it within a process', () => {
    const env = { NODE_OPTIONS: '--trace-warnings' }
    installAcpUsagePreload(env)
    const file = preloadPath(env)
    expect(path.dirname(file)).not.toBe(os.tmpdir())
    expect(path.basename(path.dirname(file))).toMatch(/^agent-desktop-acp-usage-.+/)
    expect(fs.readFileSync(file, 'utf8')).toBe(acpUsagePreloadSource())
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    }
    const previous = env.NODE_OPTIONS
    installAcpUsagePreload(env)
    expect(env.NODE_OPTIONS).toBe(previous)
    const second: NodeJS.ProcessEnv = {}
    installAcpUsagePreload(second)
    expect(preloadPath(second)).toBe(file)
  })

  it('quotes space-containing preload paths so a Node child can load them', () => {
    const env = { ...process.env, NODE_OPTIONS: '--trace-warnings' }
    installAcpUsagePreload(env)
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write("loaded")'], { env, encoding: 'utf8' })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toBe('loaded')
  })

  it.skipIf(process.platform === 'win32')('ignores the old shared path even when it is a hostile symlink', () => {
    const target = path.join(root, 'do-not-overwrite')
    const sentinel = 'throw new Error("shared preload must never execute")\n'
    fs.writeFileSync(target, sentinel)
    const legacy = path.join(os.tmpdir(), 'agent-desktop-acp-usage.cjs')
    fs.symlinkSync(target, legacy)
    const read = vi.spyOn(fs, 'readFileSync')
    const env: NodeJS.ProcessEnv = {}
    installAcpUsagePreload(env)
    expect(read).not.toHaveBeenCalled()
    expect(preloadPath(env)).not.toBe(legacy)
    expect(fs.readFileSync(target, 'utf8')).toBe(sentinel)
    cleanupAcpUsagePreload()
    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(target)).toBe(true)
  })

  it('cleans only its own directory and allows a fresh preload to be created later', () => {
    const unrelated = path.join(os.tmpdir(), 'unrelated')
    fs.writeFileSync(unrelated, 'keep')
    const first: NodeJS.ProcessEnv = {}
    installAcpUsagePreload(first)
    const directory = path.dirname(preloadPath(first))
    cleanupAcpUsagePreload()
    expect(fs.existsSync(directory)).toBe(false)
    expect(fs.existsSync(unrelated)).toBe(true)
    const second: NodeJS.ProcessEnv = {}
    installAcpUsagePreload(second)
    expect(path.dirname(preloadPath(second))).not.toBe(directory)
    cleanupAcpUsagePreload()
    cleanupAcpUsagePreload()
  })

  it('leaves NODE_OPTIONS untouched if the private file cannot be created', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('read-only temporary directory') })
    const env = { NODE_OPTIONS: '--trace-warnings' }
    installAcpUsagePreload(env)
    expect(env.NODE_OPTIONS).toBe('--trace-warnings')
    expect(fs.readdirSync(os.tmpdir())).toEqual([])
  })
})
