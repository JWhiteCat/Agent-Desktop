import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CliInfo, CliProvider, Settings } from '@shared/types'
import { resolveApiKey } from './cli'
import { resolveCodexApiKey } from './codex'
import { resolveClaudeApiKey } from './claude'
import { writeTextSafely } from './local-files'
import type { Store } from './store'

interface Entry {
  signature: string
  checkedAt: number
  info: CliInfo
  stale?: boolean
}

interface Pending {
  signature: string
  promise: Promise<CliInfo>
}

/** Includes effective environment credentials without storing their plaintext. */
export function cliInfoSignature(provider: CliProvider, settings: Settings): string {
  const config = provider === 'codex'
    ? [settings.codexPath, settings.codexApiKey, resolveCodexApiKey(settings.codexApiKey)]
    : provider === 'claude'
      ? [settings.claudePath, settings.claudeApiKey, resolveClaudeApiKey(settings.claudeApiKey)]
      : [settings.agentPath, settings.apiKey, resolveApiKey(settings.apiKey)]
  return createHash('sha256').update(JSON.stringify([provider, ...config])).digest('hex')
}

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false
  const e = value as Entry
  if (typeof e.signature !== 'string' || !/^[a-f0-9]{64}$/.test(e.signature)
    || typeof e.checkedAt !== 'number' || !Number.isFinite(e.checkedAt)
    || !e.info || typeof e.info !== 'object' || typeof e.info.found !== 'boolean'
    || (e.stale !== undefined && typeof e.stale !== 'boolean')) return false
  return (['path', 'version', 'status'] as const).every((key) => e.info[key] === undefined || typeof e.info[key] === 'string')
    && (['hasApiKey', 'bundled'] as const).every((key) => e.info[key] === undefined || typeof e.info[key] === 'boolean')
}

/** Only three entries; load once and write atomically after a detection or invalidation. */
export class CliInfoCache {
  private entries: Partial<Record<CliProvider, Entry>> | undefined
  private pending = new Map<CliProvider, Pending>()

  constructor(private readonly file: () => string) {}

  private load(): Partial<Record<CliProvider, Entry>> {
    if (this.entries) return this.entries
    this.entries = {}
    try {
      const saved = JSON.parse(fs.readFileSync(this.file(), 'utf8'))
      if (saved?.version === 1) {
        for (const provider of ['cursor', 'codex', 'claude'] as const) {
          const entry: unknown = saved.entries?.[provider]
          if (validEntry(entry)) this.entries[provider] = entry
        }
      }
    } catch { /* Missing or invalid cache is a cold start. */ }
    return this.entries
  }

  private persist(): void {
    try {
      writeTextSafely(this.file(), JSON.stringify({ version: 1, entries: this.load() }), false)
    } catch (err) {
      // A read-only disk must not turn a successful detection into an error.
      console.error('[cli-info-cache] save failed', err)
    }
  }

  invalidate(provider: CliProvider): void {
    this.pending.delete(provider)
    const entry = this.load()[provider]
    if (entry && !entry.stale) {
      entry.stale = true
      this.persist()
    }
  }

  get(provider: CliProvider, signature: string, detect: () => Promise<CliInfo>, refresh = false): Promise<CliInfo> {
    const entries = this.load()
    const pending = this.pending.get(provider)
    if (pending?.signature === signature) return pending.promise
    if (pending) this.pending.delete(provider)
    const entry = entries[provider]
    if (!refresh && !entry?.stale && entry?.signature === signature) return Promise.resolve(entry.info)

    const request: Pending = {
      signature,
      promise: Promise.resolve().then(detect).then((info) => {
        // Invalidation or a different configuration supersedes an older request.
        if (this.pending.get(provider) === request) {
          entries[provider] = { signature, checkedAt: Date.now(), info }
          this.persist()
        }
        return info
      }).finally(() => {
        if (this.pending.get(provider) === request) this.pending.delete(provider)
      })
    }
    this.pending.set(provider, request)
    return request.promise
  }
}

const caches = new WeakMap<Store, CliInfoCache>()

export function cliInfoCacheFor(store: Store): CliInfoCache {
  let cache = caches.get(store)
  if (!cache) {
    cache = new CliInfoCache(() => path.join(store.dataDir, 'cli-info-cache.json'))
    caches.set(store, cache)
  }
  return cache
}
