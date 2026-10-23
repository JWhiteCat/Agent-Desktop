import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliInfoCache, cliInfoSignature } from '../src/main/cli-info-cache'
import { DEFAULT_SETTINGS, type CliInfo, type CliProvider } from '../src/shared/types'
import * as files from '../src/main/local-files'

const providers: CliProvider[] = ['cursor', 'codex', 'claude']
const signature = 'a'.repeat(64)
const otherSignature = 'b'.repeat(64)
const info: CliInfo = { found: true, path: '/tools/agent', version: '1', status: 'Signed in', hasApiKey: true }

function deferred() {
  let resolve!: (info: CliInfo) => void
  const promise = new Promise<CliInfo>((yes) => { resolve = yes })
  return { promise, resolve }
}

describe('persistent CLI detection cache', () => {
  let directory: string
  let file: string
  let cache: CliInfoCache

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-cli-info-'))
    file = path.join(directory, 'cli-info-cache.json')
    cache = new CliInfoCache(() => file)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    const resolved = path.resolve(directory)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-cli-info-')) throw new Error('Unexpected fixture directory')
    fs.rmSync(resolved, { recursive: true, force: true })
  })

  it.each(providers)('reuses %s results in memory and after restart, without a TTL', async (provider) => {
    const detect = vi.fn().mockResolvedValue(info)
    await expect(cache.get(provider, signature, detect)).resolves.toEqual(info)
    await expect(cache.get(provider, signature, detect)).resolves.toEqual(info)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved.entries[provider].checkedAt).toBeGreaterThan(0)
    saved.entries[provider].checkedAt = 1
    fs.writeFileSync(file, JSON.stringify(saved))
    await expect(new CliInfoCache(() => file).get(provider, signature, detect)).resolves.toEqual(info)
    expect(detect).toHaveBeenCalledOnce()
  })

  it('caches missing CLIs and replaces them on explicit refresh', async () => {
    const detect = vi.fn().mockResolvedValueOnce({ found: false }).mockResolvedValue(info)
    await cache.get('cursor', signature, detect)
    await expect(cache.get('cursor', signature, detect)).resolves.toEqual({ found: false })
    await expect(cache.get('cursor', signature, detect, true)).resolves.toEqual(info)
    expect(detect).toHaveBeenCalledTimes(2)
  })

  it.each(['broken JSON', 'null', '{"version":2}', '{"version":1,"entries":{"cursor":{"info":{"found":true}}}}'])('recovers from unusable cache %s', async (saved) => {
    fs.writeFileSync(file, saved)
    const detect = vi.fn().mockResolvedValue(info)
    await expect(cache.get('cursor', signature, detect)).resolves.toEqual(info)
    expect(detect).toHaveBeenCalledOnce()
  })

  it('only refreshes the provider whose configuration changed', async () => {
    const detect = vi.fn().mockResolvedValue(info)
    for (const provider of providers) await cache.get(provider, signature, detect)
    await cache.get('cursor', otherSignature, detect)
    for (const provider of ['codex', 'claude'] as const) await cache.get(provider, signature, detect)
    expect(detect).toHaveBeenCalledTimes(4)
  })

  it('persists invalidation even when the settings page closes before rechecking', async () => {
    const detect = vi.fn().mockResolvedValue(info)
    for (const provider of providers) await cache.get(provider, signature, detect)
    cache.invalidate('cursor')
    const restarted = new CliInfoCache(() => file)
    for (const provider of providers) await restarted.get(provider, signature, detect)
    expect(detect).toHaveBeenCalledTimes(4)
  })

  it('shares an in-flight request, including forced refreshes', async () => {
    const pending = deferred()
    const detect = vi.fn(() => pending.promise)
    const a = cache.get('cursor', signature, detect)
    const b = cache.get('cursor', signature, detect, true)
    expect(b).toBe(a)
    pending.resolve(info)
    await a
    expect(detect).toHaveBeenCalledOnce()
  })

  it.each(['configuration', 'invalidation'] as const)('ignores late results after %s', async (reason) => {
    const old = deferred()
    const previous = cache.get('cursor', signature, () => old.promise)
    if (reason === 'invalidation') cache.invalidate('cursor')
    const nextSignature = reason === 'configuration' ? otherSignature : signature
    const latest = { ...info, version: '2' }
    await cache.get('cursor', nextSignature, async () => latest)
    old.resolve(info)
    await previous
    const detect = vi.fn()
    await expect(new CliInfoCache(() => file).get('cursor', nextSignature, detect)).resolves.toEqual(latest)
    expect(detect).not.toHaveBeenCalled()
  })

  it('does not let a superseded request replace a cache hit after switching back', async () => {
    await cache.get('cursor', signature, async () => info)
    const old = deferred()
    const previous = cache.get('cursor', otherSignature, () => old.promise)
    await expect(cache.get('cursor', signature, vi.fn())).resolves.toEqual(info)
    old.resolve({ ...info, version: 'obsolete' })
    await previous
    await expect(new CliInfoCache(() => file).get('cursor', signature, vi.fn())).resolves.toEqual(info)
  })

  it('preserves the previous result after refresh failure and allows retry', async () => {
    await cache.get('cursor', signature, async () => info)
    const saved = fs.readFileSync(file, 'utf8')
    await expect(cache.get('cursor', signature, async () => { throw new Error('offline') }, true)).rejects.toThrow('offline')
    expect(fs.readFileSync(file, 'utf8')).toBe(saved)
    await expect(cache.get('cursor', signature, vi.fn())).resolves.toEqual(info)
    await expect(cache.get('cursor', signature, async () => ({ found: false }), true)).resolves.toEqual({ found: false })
  })

  it('does not cache a rejected initial detection', async () => {
    const detect = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(info)
    await expect(cache.get('cursor', signature, detect)).rejects.toThrow('timeout')
    await expect(cache.get('cursor', signature, detect)).resolves.toEqual(info)
    expect(detect).toHaveBeenCalledTimes(2)
  })

  it('keeps successful results in memory when persistence fails', async () => {
    vi.spyOn(files, 'writeTextSafely').mockImplementation(() => { throw new Error('read only') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const detect = vi.fn().mockResolvedValue(info)
    await expect(cache.get('cursor', signature, detect)).resolves.toEqual(info)
    await expect(cache.get('cursor', signature, detect)).resolves.toEqual(info)
    expect(detect).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledOnce()
  })

  it.each(providers)('fingerprints %s settings and effective environment credentials without plaintext keys', async (provider) => {
    const envKey = { cursor: 'CURSOR_API_KEY', codex: 'CODEX_API_KEY', claude: 'ANTHROPIC_API_KEY' }[provider]
    vi.stubEnv(envKey, 'secret-one')
    const first = cliInfoSignature(provider, DEFAULT_SETTINGS)
    vi.stubEnv(envKey, 'secret-two')
    expect(cliInfoSignature(provider, DEFAULT_SETTINGS)).not.toBe(first)
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'configured-secret', codexApiKey: 'configured-secret', claudeApiKey: 'configured-secret' }
    const configured = cliInfoSignature(provider, settings)
    vi.stubEnv(envKey, 'secret-three')
    expect(cliInfoSignature(provider, settings)).toBe(configured)
    await cache.get(provider, configured, async () => info)
    const saved = fs.readFileSync(file, 'utf8')
    expect(saved).not.toContain('configured-secret')
    expect(saved).not.toContain('secret-three')
  })
})
