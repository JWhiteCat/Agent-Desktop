import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'grokbot-cache-missing') },
  dialog: { showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))

import { GrokBotClient, withAttachments } from '../src/main/grokbot'
import { accountTag, GrokBotChatCache } from '../src/main/grokbot-cache'
import { GrokBotFiles } from '../src/main/grokbot-files'
import { grokbotHandlers } from '../src/main/ipc/grokbot'
import type { IpcDeps } from '../src/main/ipc/deps'
import { applyGrokBotPage } from '../src/shared/grokbot'
import type { GrokBotHistory, GrokBotMessage, Settings } from '../src/shared/types'
import { applyGrokBotPoll, cachedGrokBotChat, forgetGrokBotChat, rememberGrokBotChat } from '../src/renderer/src/store/grokbot'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  forgetGrokBotChat()
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-cache-'))
  dirs.push(dir)
  return dir
}

const turn = { idle: true, inFlight: false, queued: 0 }
const msg = (seq: number, text = `m${seq}`, updatedSeq = seq, role: 'user' | 'bot' = 'bot'): GrokBotMessage => ({
  seq: String(seq),
  updatedSeq: String(updatedSeq),
  role,
  text,
  createdAtMs: seq
})
const page = (messages: GrokBotMessage[], cursor: string, sessionId = 's1', reset?: boolean) => ({ messages, cursor, turn, sessionId, reset })

describe('grok bot message cache on disk', () => {
  it('saves full loads, continues from its cursor, and never skips unseen entries', () => {
    const file = path.join(tempDir(), 'grokbot-cache.json')
    const cache = new GrokBotChatCache(() => file)
    cache.update('a', 'acct', '5', page([msg(6)], '6'))
    expect(cache.get('a', 'acct')).toBeUndefined()

    cache.update('a', 'acct', '-1', page([msg(1), msg(2)], '2'), true)
    expect(cache.get('a', 'acct')).toMatchObject({ cursor: '2', sessionId: 's1' })

    cache.update('a', 'acct', '2', page([msg(3), msg(2, 'edited', 3)], '3'))
    expect(cache.get('a', 'acct')?.cursor).toBe('3')
    expect(cache.get('a', 'acct')?.messages.map((m) => m.text)).toEqual(['m1', 'edited', 'm3'])

    // A page that starts beyond the saved cursor leaves a gap: keep the messages, not the cursor.
    cache.update('a', 'acct', '7', page([msg(8)], '8'))
    expect(cache.get('a', 'acct')?.cursor).toBe('3')

    // Another session behind the same name replaces the entry only with a full load.
    cache.update('a', 'acct', '3', page([msg(9)], '9', 's2'))
    expect(cache.get('a', 'acct')?.sessionId).toBe('s1')
    cache.update('a', 'acct', '-1', page([msg(1)], '1', 's2', true))
    expect(cache.get('a', 'acct')).toMatchObject({ sessionId: 's2', cursor: '1', messages: [{ seq: '1' }] })

    expect(cache.get('a', 'other')).toBeUndefined()
    expect(cache.get('a', '')).toBeUndefined()
  })

  it('persists across restarts and ignores unreadable files', () => {
    const file = path.join(tempDir(), 'grokbot-cache.json')
    const cache = new GrokBotChatCache(() => file)
    cache.update('a', 'acct', '-1', page([msg(1)], '1'), true)
    cache.flush()
    expect(new GrokBotChatCache(() => file).get('a', 'acct')?.messages).toHaveLength(1)
    fs.writeFileSync(file, 'not json')
    expect(new GrokBotChatCache(() => file).get('a', 'acct')).toBeUndefined()
    fs.writeFileSync(file, JSON.stringify({ version: 1, bots: { a: { account: 'acct', sessionId: 's', cursor: '1', messages: [{ seq: 1 }, msg(2)] } } }))
    expect(new GrokBotChatCache(() => file).get('a', 'acct')?.messages.map((m) => m.seq)).toEqual(['2'])
  })

  it('bounds messages per bot and the number of bots', () => {
    let now = 0
    const cache = new GrokBotChatCache(() => path.join(tempDir(), 'c.json'), { maxBots: 2, maxBotBytes: 2_000 }, () => ++now)
    const many = Array.from({ length: 100 }, (_, i) => msg(i + 1, 'x'.repeat(50)))
    cache.update('big', 'acct', '-1', page(many, '100'), true)
    const big = cache.get('big', 'acct')!
    expect(big.truncated).toBe(true)
    expect(big.messages.length).toBeLessThan(100)
    expect(big.messages.at(-1)?.seq).toBe('100')
    expect(Buffer.byteLength(JSON.stringify(big.messages))).toBeLessThanOrEqual(2_000)

    cache.update('b', 'acct', '-1', page([msg(1)], '1'), true)
    cache.update('c', 'acct', '-1', page([msg(1)], '1'), true)
    expect(cache.get('big', 'acct')).toBeUndefined()
    expect(cache.get('b', 'acct')).toBeDefined()
    expect(cache.get('c', 'acct')).toBeDefined()
  })

  it('patches only messages it already has', () => {
    const cache = new GrokBotChatCache(() => path.join(tempDir(), 'c.json'))
    cache.update('a', 'acct', '-1', page([msg(1, '')], '1'), true)
    cache.patch('a', 'acct', [{ ...msg(1, ''), attachments: [] }, { ...msg(2), attachments: [] }])
    expect(cache.get('a', 'acct')?.messages).toEqual([{ ...msg(1, ''), attachments: [] }])
  })

  it('tags accounts by a short hash, never the key', () => {
    expect(accountTag('key_secret')).toBe(createHash('sha256').update('key_secret').digest('hex').slice(0, 16))
    expect(accountTag('key_secret')).not.toContain('secret')
    expect(accountTag('')).toBe('')
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A fake API with one bot whose transcript can change, recording each request. */
function fakeApi() {
  const api = {
    sessionId: '42',
    entries: [
      { seq: '1', updatedSeq: '1', kind: 'message', role: 'user', text: 'hi', createdAtMs: 1 },
      { seq: '2', updatedSeq: '2', kind: 'send-message', text: 'hello', createdAtMs: 2 }
    ] as Record<string, unknown>[],
    failNext: 0,
    calls: [] as string[]
  }
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/v0/grokbot/sessions')) {
      api.calls.push('POST sessions')
      return jsonResponse({ id: api.sessionId, name: 'test', createdAtMs: 0, latestUpdatedSeq: '0' })
    }
    const match = /sessions\/(\w+)\/entries\?afterUpdatedSeq=(-?\w+)/.exec(url)
    if (init.method === 'GET' && match) {
      api.calls.push(`GET ${match[1]} after=${match[2]}`)
      if (api.failNext) {
        const status = api.failNext
        api.failNext = 0
        return jsonResponse({ error: 'nope' }, status)
      }
      if (match[1] !== api.sessionId) return jsonResponse({ error: 'Session not found' }, 404)
      const after = Number(match[2])
      const entries = api.entries.filter((e) => Number(e.updatedSeq) > after)
      const latest = entries.length ? String(Math.max(...entries.map((e) => Number(e.updatedSeq)))) : match[2]
      return jsonResponse({ entries, latestUpdatedSeq: latest, turn })
    }
    return jsonResponse({ error: 'unexpected' }, 500)
  })
  return { api, fetchImpl }
}

function grokBotAppData(): string {
  // A roster with the `test` bot; no transcript or attachment cache.
  const root = tempDir()
  const dir = path.join(root, 'Grok Bot', 'sand-client-persistence')
  fs.mkdirSync(dir, { recursive: true })
  const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
  const encode = (text: string) => {
    let bits = 0
    let value = 0
    let out = ''
    for (const byte of Buffer.from(text)) {
      value = (value << 8) | byte
      bits += 8
      while (bits >= 5) {
        bits -= 5
        out += BASE32[(value >> bits) & 31]
      }
    }
    return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out
  }
  fs.writeFileSync(path.join(dir, `${encode('sand.client.slice.account.a.roster.last-roster')}.blob`), JSON.stringify({ value: { rows: [{ id: 'bot-1', name: 'test' }] } }))
  return root
}

function handlersFor(root: string, fetchImpl: typeof fetch, cacheFile: string, key = 'key_1') {
  const settings = { apiKey: key, grokbotBots: [] } as unknown as Settings
  const client = new GrokBotClient(() => settings.apiKey, fetchImpl, () => 'https://api.test')
  const cache = new GrokBotChatCache(() => cacheFile)
  const handlers = grokbotHandlers({ store: { settings, updateSettings: vi.fn() }, broadcast: vi.fn() } as unknown as IpcDeps, {
    appDataDir: () => root,
    client,
    files: new GrokBotFiles(() => path.join(root, 'none')),
    cache
  })
  return { handlers, cache, settings }
}

describe('grok bot incremental loading', () => {
  it('reuses session ids and saved messages after a restart, then polls only new entries', async () => {
    const root = grokBotAppData()
    const cacheFile = path.join(root, 'grokbot-cache.json')
    const { api, fetchImpl } = fakeApi()

    const first = handlersFor(root, fetchImpl as unknown as typeof fetch, cacheFile)
    expect(await first.handlers['grokbot:cached']('test')).toBeNull()
    const history = (await first.handlers['grokbot:history']('test')) as GrokBotHistory
    expect(history).toMatchObject({ cursor: '2', sessionId: '42' })
    await first.handlers['grokbot:poll']('test', '2', '42')
    expect(api.calls).toEqual(['POST sessions', 'GET 42 after=-1', 'GET 42 after=2', 'GET 42 after=2'])
    first.cache.flush()

    // Restart: a new client and cache read the saved file.
    api.calls = []
    api.entries.push({ seq: '3', updatedSeq: '3', kind: 'send-message', text: 'new', createdAtMs: 3 })
    const second = handlersFor(root, fetchImpl as unknown as typeof fetch, cacheFile)
    const saved = (await second.handlers['grokbot:cached']('test')) as GrokBotHistory
    expect(saved).toMatchObject({ cursor: '2', sessionId: '42' })
    expect(saved.messages.map((m) => m.text)).toEqual(['hi', 'hello'])
    expect(api.calls).toEqual([])
    const next = (await second.handlers['grokbot:poll']('test', saved.cursor, saved.sessionId)) as GrokBotHistory
    expect(next.messages.map((m) => m.text)).toEqual(['new'])
    expect(next.reset).toBeUndefined()
    expect(api.calls).toEqual(['GET 42 after=2'])
    expect(second.cache.get('test', accountTag('key_1'))?.cursor).toBe('3')
  })

  it('falls back to full history for a rejected cursor or a vanished session', async () => {
    const root = grokBotAppData()
    const { api, fetchImpl } = fakeApi()
    const { handlers } = handlersFor(root, fetchImpl as unknown as typeof fetch, path.join(root, 'c.json'))
    await handlers['grokbot:history']('test')

    api.calls = []
    api.failNext = 400
    const bad = (await handlers['grokbot:poll']('test', 'abc', '42')) as GrokBotHistory
    expect(bad).toMatchObject({ reset: true, cursor: '2' })
    expect(bad.messages).toHaveLength(2)
    expect(api.calls).toEqual(['GET 42 after=abc', 'POST sessions', 'GET 42 after=-1', 'GET 42 after=2'])

    // The bot was recreated: the old session id is gone.
    api.calls = []
    api.sessionId = '43'
    const moved = (await handlers['grokbot:poll']('test', '2', '42')) as GrokBotHistory
    expect(moved).toMatchObject({ reset: true, sessionId: '43' })
    expect(api.calls[0]).toBe('GET 42 after=2')
    expect(api.calls).toContain('POST sessions')
  })

  it('reloads when the shown session differs or the server is behind the cursor', async () => {
    const root = grokBotAppData()
    const { api, fetchImpl } = fakeApi()
    const { handlers, settings } = handlersFor(root, fetchImpl as unknown as typeof fetch, path.join(root, 'c.json'))
    await handlers['grokbot:history']('test')

    expect(await handlers['grokbot:poll']('test', '2', 'other')).toMatchObject({ reset: true, sessionId: '42' })

    // Another API key resolves the name again and reloads.
    settings.apiKey = 'key_2'
    api.sessionId = '77'
    api.calls = []
    expect(await handlers['grokbot:poll']('test', '2', '42')).toMatchObject({ reset: true, sessionId: '77' })
    expect(api.calls[0]).toBe('POST sessions')
    expect(await handlers['grokbot:cached']('test')).toMatchObject({ sessionId: '77' })
  })

  it('caches session ids per name and drops them when the key changes', async () => {
    const { api, fetchImpl } = fakeApi()
    let key = 'k1'
    const client = new GrokBotClient(() => key, fetchImpl as unknown as typeof fetch, () => 'https://api.test')
    client.rememberSession('test', '42')
    await client.poll('test', '2')
    expect(api.calls).toEqual(['GET 42 after=2'])
    key = 'k2'
    expect(client.knownSession('test')).toBeUndefined()
    await client.poll('test', '2')
    expect(api.calls.slice(1)).toEqual(['POST sessions', 'GET 42 after=2'])
  })
})

describe('grok bot attachment index', () => {
  it('rescans only for missing hashes, at most once per interval', async () => {
    const root = tempDir()
    fs.writeFileSync(path.join(root, 'a'), 'aaa')
    const files = new GrokBotFiles(() => root)
    const refresh = vi.spyOn(files, 'refresh')
    const hashA = createHash('sha256').update('aaa').digest('hex')
    await files.ensure([hashA])
    await files.ensure([hashA])
    expect(refresh).toHaveBeenCalledTimes(1)
    await files.ensure(['f'.repeat(64)], 60_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    await files.ensure(['f'.repeat(64)], 0)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('keeps saved files on messages the Grok Bot transcript no longer has', async () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'cache'))
    fs.writeFileSync(path.join(root, 'cache', 'x'), 'svg')
    const sha = createHash('sha256').update('svg').digest('hex')
    const files = new GrokBotFiles(() => path.join(root, 'cache'))
    const saved: GrokBotMessage = { ...msg(4, ''), attachments: [{ sha256: sha, name: 'a.svg', mimeType: 'image/svg+xml', kind: 'image', available: false }] }
    const [out] = await withAttachments(root, { id: 'bot' }, [saved], files)
    expect(out.attachments?.[0]).toMatchObject({ available: true, size: 3 })
    expect(files.isKnown(sha)).toBe(true)
  })
})

describe('renderer chat cache', () => {
  it('remembers chats per bot name with a bounded size', () => {
    rememberGrokBotChat('a', { messages: [msg(1)], cursor: '1' })
    expect(cachedGrokBotChat('a')?.cursor).toBe('1')
    for (let i = 0; i < 40; i++) rememberGrokBotChat(`b${i}`, { messages: [], cursor: '0' })
    expect(cachedGrokBotChat('a')).toBeUndefined()
    expect(cachedGrokBotChat('b39')).toBeDefined()
  })

  it('merges poll pages by seq and replaces on reset', () => {
    const chat = { messages: [msg(1), msg(2, 'old')], cursor: '2', sessionId: 's1' }
    const merged = applyGrokBotPoll(chat, { messages: [msg(2, 'new', 3), msg(2, 'stale', 1), msg(3)], cursor: '3', turn })
    expect(merged.messages.map((m) => m.text)).toEqual(['m1', 'new', 'm3'])
    expect(merged).toMatchObject({ cursor: '3', sessionId: 's1' })
    const reset = applyGrokBotPoll(chat, { messages: [msg(5)], cursor: '5', turn, sessionId: 's2', reset: true })
    expect(reset).toMatchObject({ cursor: '5', sessionId: 's2', messages: [{ seq: '5' }] })
    expect(applyGrokBotPage([msg(1)], { messages: [] })).toEqual([msg(1)])
  })
})
