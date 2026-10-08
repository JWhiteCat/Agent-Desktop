import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'grokbot-extras-missing') },
  dialog: { showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))

import { attachReplica, GrokBotClient, matchReplica, readReplica, toReplicaEntry, withAttachments, type ReplicaEntry } from '../src/main/grokbot'
import { grokBotFileResponse, GrokBotFiles, mimeTypeFor, safeFileName } from '../src/main/grokbot-files'
import { grokbotHandlers } from '../src/main/ipc/grokbot'
import type { IpcDeps } from '../src/main/ipc/deps'
import { handlersForRemote } from '../src/main/remote-runtime'
import {
  grokBotFileUrl,
  mergeManualGrokBots,
  normalizeGrokBotNames,
  unresolvedGrokBotMessages,
  validateGrokBotName
} from '../src/shared/grokbot'
import type { AppState, GrokBotInfo, GrokBotMessage, Settings } from '../src/shared/types'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
function encodeBase32(text: string): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of Buffer.from(text, 'utf8')) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32[(value >> bits) & 31]
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-extras-'))
  dirs.push(dir)
  return dir
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4"/></svg>')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const SVG_SHA = sha(SVG)
const PNG_SHA = sha(PNG)
const BOT_ID = '4a064b19-94a4-4de3-8a11-12681a4ee3db'
const ACCOUNT = 'auth0%7Cuser_1'
const boxUrl = (name: string) => `file:///home/box/agent-data/agents/${BOT_ID}/attachments/${name}`

/** Grok Bot app data with the test bot in the roster, its cached transcript, and an attachment cache. */
function grokBotAppData(opts: { cache?: Record<string, Buffer>; entries?: unknown[] } = {}): string {
  const root = tempDir()
  const persistence = path.join(root, 'Grok Bot', 'sand-client-persistence')
  fs.mkdirSync(persistence, { recursive: true })
  const blobs: Record<string, unknown> = {
    'sand.client.slice.client-meta.account-slot': { value: 'auth0|user_1' },
    [`sand.client.slice.account.${ACCOUNT}.roster.last-roster`]: {
      value: { rows: [{ id: BOT_ID, name: 'test', avatarColor: 'blue', lastActivityAt: 5 }] }
    },
    [`sand.client.slice.account.${ACCOUNT}.transcript.replicas.${BOT_ID}`]: {
      schemaVersion: 1,
      value: {
        entries: opts.entries ?? [
          { kind: 'message', id: 't0u', role: 'user', content: 'draw', timestampMs: 1000, seq: 1 },
          {
            kind: 'send-message',
            id: 't0s1',
            message: { type: 'text', content: 'done', images: [{ url: boxUrl(`${PNG_SHA}.png`), alt: 'preview', width: 700, height: 420 }] },
            timestampMs: 2000,
            seq: 3
          },
          { kind: 'send-message', id: 't0s2', message: { type: 'attachment', url: boxUrl(`${SVG_SHA}.svg`), file_name: 'pelican_bike.svg' }, timestampMs: 2100, seq: 4 },
          { kind: 'send-message', id: 't0s3', message: { type: 'widget', widget: { prompt: '?' } }, timestampMs: 3000, seq: 5 }
        ]
      }
    }
  }
  for (const [key, value] of Object.entries(blobs)) fs.writeFileSync(path.join(persistence, `${encodeBase32(key)}.blob`), JSON.stringify(value))
  const cache = path.join(root, 'Grok Bot', 'attachment-image-cache')
  fs.mkdirSync(cache, { recursive: true })
  for (const [name, bytes] of Object.entries(opts.cache ?? {})) fs.writeFileSync(path.join(cache, name), bytes)
  return root
}

const cacheDir = (root: string) => path.join(root, 'Grok Bot', 'attachment-image-cache')

function apiMessages(): GrokBotMessage[] {
  return [
    { seq: '1', updatedSeq: '1', role: 'user', text: 'draw', createdAtMs: 1100 },
    { seq: '3', updatedSeq: '3', role: 'bot', text: 'done', createdAtMs: 2050 },
    { seq: '4', updatedSeq: '4', role: 'bot', text: '', createdAtMs: 2150 },
    { seq: '5', updatedSeq: '5', role: 'bot', text: '', createdAtMs: 3020 }
  ]
}

describe('grok bot names', () => {
  it('trims and validates names, and normalizes the saved list', () => {
    expect(validateGrokBotName('  Ada  ')).toBe('Ada')
    expect(() => validateGrokBotName('   ')).toThrow()
    expect(() => validateGrokBotName('x'.repeat(101))).toThrow()
    expect(() => validateGrokBotName('a\nb')).toThrow()
    expect(normalizeGrokBotNames([' Ada ', 'Ada', '', 3, 'Bob'])).toEqual(['Ada', 'Bob'])
    expect(normalizeGrokBotNames('Ada')).toEqual([])
  })

  it('appends manual names the roster lacks, with stable synthetic ids', () => {
    const roster: GrokBotInfo = { id: 'r1', name: 'test', description: '', color: 'blue', lastText: 'hi', lastActivityAt: 1 }
    const merged = mergeManualGrokBots({ bots: [roster] }, ['test', 'Ada'])
    expect(merged.bots.map((b) => b.id)).toEqual(['r1', 'manual:Ada'])
    expect(merged.bots[1]).toMatchObject({ name: 'Ada', manual: true, color: 'gray', lastText: '' })
    expect(mergeManualGrokBots({ bots: [], reason: 'no-app' }, ['Ada'])).toMatchObject({ reason: 'no-app', bots: [{ id: 'manual:Ada' }] })
  })
})

describe('grok bot transcript cache', () => {
  it('parses both attachment shapes from cached entries', () => {
    const image = toReplicaEntry({ kind: 'send-message', seq: 3, timestampMs: 5, message: { type: 'text', images: [{ url: boxUrl(`${PNG_SHA}.png`), alt: 'a', width: 7, height: 4 }] } })
    expect(image?.attachments).toEqual([{ sha256: PNG_SHA, name: `${PNG_SHA}.png`, mimeType: 'image/png', kind: 'image', alt: 'a', width: 7, height: 4 }])
    const file = toReplicaEntry({ kind: 'send-message', seq: 4, timestampMs: 5, message: { type: 'attachment', url: boxUrl(`${SVG_SHA}.svg`), file_name: 'pelican_bike.svg' } })
    expect(file).toMatchObject({ seq: '4', type: 'attachment', attachments: [{ sha256: SVG_SHA, name: 'pelican_bike.svg', mimeType: 'image/svg+xml', kind: 'image' }] })
    const other = toReplicaEntry({ kind: 'send-message', seq: 6, message: { type: 'attachment', url: 'file:///x/report.pdf', file_name: '../../evil/report.pdf' } })
    expect(other?.attachments[0]).toMatchObject({ sha256: '', name: 'report.pdf', mimeType: 'application/pdf', kind: 'file' })
    expect(toReplicaEntry({ kind: 'send-message', seq: 'x' })).toBeUndefined()
  })

  it('reads the bot transcript of the active account', () => {
    const replica = readReplica(grokBotAppData(), BOT_ID)
    expect([...replica!.keys()]).toEqual(['1', '3', '4', '5'])
    expect(readReplica(grokBotAppData(), 'other-bot')).toBeUndefined()
  })

  it('aligns by seq only when kind, role, and time agree', () => {
    const entry: ReplicaEntry = { seq: '4', kind: 'send-message', timestampMs: 2100, attachments: [] }
    const replica = new Map([['4', entry]])
    const message: GrokBotMessage = { seq: '4', updatedSeq: '4', role: 'bot', text: '', createdAtMs: 2150 }
    expect(matchReplica(message, replica)).toBe(entry)
    expect(matchReplica({ ...message, role: 'user' }, replica)).toBeUndefined()
    expect(matchReplica({ ...message, createdAtMs: 2100 + 10 * 60_000 }, replica)).toBeUndefined()
    expect(matchReplica({ ...message, seq: '5' }, replica)).toBeUndefined()
    expect(matchReplica(message, new Map([['4', { ...entry, kind: 'message', role: 'user' }]]))).toBeUndefined()
  })

  it('adds attachments, availability, and non-file types to bot messages', () => {
    const replica = readReplica(grokBotAppData(), BOT_ID)
    const out = attachReplica(apiMessages(), replica, (hash) => (hash === SVG_SHA ? { size: SVG.length } : undefined))
    expect(out[0].attachments).toBeUndefined()
    expect(out[1].attachments).toMatchObject([{ sha256: PNG_SHA, available: false }])
    expect(out[2].attachments).toEqual([
      { sha256: SVG_SHA, name: 'pelican_bike.svg', mimeType: 'image/svg+xml', kind: 'image', available: true, size: SVG.length }
    ])
    expect(out[3]).toMatchObject({ attachments: [], localType: 'widget' })
    expect(attachReplica(apiMessages(), undefined)).toEqual(apiMessages())
  })

  it('marks only recent bot messages without cache data for rechecks', () => {
    const messages = apiMessages()
    messages[2] = { ...messages[2], attachments: [] }
    expect(unresolvedGrokBotMessages(messages, 2000).map((m) => m.seq)).toEqual(['3', '5'])
    expect(unresolvedGrokBotMessages(messages, 2500).map((m) => m.seq)).toEqual(['5'])
  })
})

describe('grok bot file cache', () => {
  it('finds bytes by SHA-256 and serves only hashes seen in a transcript', async () => {
    const root = grokBotAppData({ cache: { '411406384182133f9a6219b14687211b': SVG, other: Buffer.from('nope') } })
    const files = new GrokBotFiles(() => cacheDir(root))
    const messages = await withAttachments(root, { id: BOT_ID }, apiMessages(), files)
    expect(messages[2].attachments?.[0]).toMatchObject({ available: true, size: SVG.length })
    expect(messages[1].attachments?.[0]).toMatchObject({ available: false })

    const cached = await files.read(SVG_SHA)
    expect(cached).toMatchObject({ name: 'pelican_bike.svg', mimeType: 'image/svg+xml' })
    expect(cached.bytes.equals(SVG)).toBe(true)
    await expect(files.read(sha(Buffer.from('nope')))).rejects.toThrow()
    await expect(files.read('../../etc/passwd')).rejects.toThrow()
    await expect(files.read(PNG_SHA)).rejects.toThrow()

    const ok = await grokBotFileResponse(files, grokBotFileUrl(SVG_SHA))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/svg+xml')
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(Buffer.from(await ok.arrayBuffer()).equals(SVG)).toBe(true)
    expect((await grokBotFileResponse(files, grokBotFileUrl(sha(Buffer.from('nope'))))).status).toBe(404)
    expect((await grokBotFileResponse(files, 'grokbot-file://not-a-hash/')).status).toBe(404)
  })

  it('rejects a cache file whose bytes changed after indexing', async () => {
    const root = grokBotAppData({ cache: { a: SVG } })
    const files = new GrokBotFiles(() => cacheDir(root))
    await withAttachments(root, { id: BOT_ID }, apiMessages(), files)
    const file = path.join(cacheDir(root), 'a')
    const stat = fs.statSync(file)
    fs.writeFileSync(file, Buffer.from(SVG.toString().replace('r="4"', 'r="5"')))
    fs.utimesSync(file, stat.atime, stat.mtime)
    await expect(files.read(SVG_SHA)).rejects.toThrow()
  })

  it('reuses hashes until size or mtime changes', async () => {
    const root = grokBotAppData({ cache: { a: SVG } })
    const files = new GrokBotFiles(() => cacheDir(root))
    const read = vi.spyOn(fs.promises, 'readFile')
    await files.refresh()
    await files.refresh()
    expect(read).toHaveBeenCalledTimes(1)
    read.mockRestore()
    expect(files.lookup(SVG_SHA)?.size).toBe(SVG.length)
  })

  it('leaves bots added by hand alone', async () => {
    const root = grokBotAppData({ cache: { a: SVG } })
    const messages = apiMessages()
    expect(await withAttachments(root, { id: 'manual:test', manual: true }, messages, new GrokBotFiles(() => cacheDir(root)))).toBe(messages)
  })

  it('maps names to types and safe file names', () => {
    expect(mimeTypeFor('a.SVG')).toBe('image/svg+xml')
    expect(mimeTypeFor('a.exe')).toBe('application/octet-stream')
    expect(safeFileName('..\\..\\x/pelican.svg', 'f')).toBe('pelican.svg')
    expect(safeFileName('..', 'f')).toBe('f')
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function handlerFixture(root: string, manual: string[] = []) {
  const settings = { apiKey: 'key_1', grokbotBots: manual } as unknown as Settings
  const store = {
    get settings() {
      return settings
    },
    updateSettings: vi.fn((patch: Partial<Settings>) => Object.assign(settings, patch))
  }
  const broadcast = vi.fn()
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/v0/grokbot/sessions')) {
      const body = JSON.parse(String(init.body)) as { name: string }
      return jsonResponse({ id: `s-${body.name}`, name: body.name, createdAtMs: 0, latestUpdatedSeq: '0' })
    }
    if (url.includes('/entries')) {
      return jsonResponse({
        entries: [
          { seq: '3', updatedSeq: '3', kind: 'send-message', text: 'done', createdAtMs: 2050 },
          { seq: '4', updatedSeq: '4', kind: 'send-message', createdAtMs: 2150 }
        ],
        latestUpdatedSeq: '4',
        turn: { idle: true, inFlight: false, queued: 0 }
      })
    }
    return jsonResponse({ error: 'unexpected' }, 500)
  })
  const client = new GrokBotClient(() => 'key_1', fetchImpl as unknown as typeof fetch, () => 'https://api.test')
  const files = new GrokBotFiles(() => cacheDir(root))
  const handlers = grokbotHandlers({ store, broadcast, getWindow: () => null } as unknown as IpcDeps, { appDataDir: () => root, client, files })
  return { handlers, settings, store, broadcast, fetchImpl, files }
}

describe('grok bot IPC', () => {
  it('lists cached and manual bots, and falls back to manual names without a cache', async () => {
    const { handlers } = handlerFixture(grokBotAppData(), ['test', 'Ada'])
    const list = (await handlers['grokbot:list']()) as { bots: GrokBotInfo[]; hasApiKey: boolean }
    expect(list.bots.map((b) => [b.id, b.name])).toEqual([[BOT_ID, 'test'], ['manual:Ada', 'Ada']])
    expect(list.hasApiKey).toBe(true)

    const empty = handlerFixture(tempDir(), ['Ada'])
    expect(await empty.handlers['grokbot:list']()).toMatchObject({ reason: 'no-app', bots: [{ id: 'manual:Ada', manual: true }] })
  })

  it('guards history, polling, sending, and interrupts against unlisted names', async () => {
    const { handlers, fetchImpl } = handlerFixture(grokBotAppData(), ['Ada'])
    await expect(async () => handlers['grokbot:history']('Nobody')).rejects.toThrow('Nobody')
    await expect(async () => handlers['grokbot:poll']('Nobody', '1')).rejects.toThrow()
    await expect(async () => handlers['grokbot:send']('Nobody', 'hi')).rejects.toThrow()
    await expect(async () => handlers['grokbot:interrupt']('Nobody')).rejects.toThrow()
    await expect(async () => handlers['grokbot:attachments']('Nobody', [])).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()

    await handlers['grokbot:history']('Ada')
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({ name: 'Ada' })
  })

  it('adds cached files to history of a roster bot', async () => {
    const root = grokBotAppData({ cache: { a: SVG } })
    const { handlers, files } = handlerFixture(root)
    const history = (await handlers['grokbot:history']('test')) as { messages: GrokBotMessage[] }
    expect(history.messages.map((m) => m.seq)).toEqual(['3', '4'])
    expect(history.messages[1].attachments).toMatchObject([{ name: 'pelican_bike.svg', available: true }])
    expect(files.isKnown(SVG_SHA)).toBe(true)
    const data = (await handlers['grokbot:attachmentData'](SVG_SHA)) as { data: string; mimeType: string }
    expect(Buffer.from(data.data, 'base64').equals(SVG)).toBe(true)
    await expect(handlers['grokbot:attachmentData']('f'.repeat(64))).rejects.toThrow()

    const rechecked = (await handlers['grokbot:attachments']('test', [{ seq: '4', updatedSeq: '4', role: 'bot', text: '', createdAtMs: 2150, extra: 'x' }])) as GrokBotMessage[]
    expect(rechecked[0]).toMatchObject({ seq: '4', attachments: [{ sha256: SVG_SHA }] })
  })

  it('creates a bot by name and adds it to the manual list', async () => {
    const { handlers, settings, broadcast, fetchImpl } = handlerFixture(grokBotAppData())
    const bot = await handlers['grokbot:create']('  New Bot  ')
    expect(bot).toMatchObject({ id: 'manual:New Bot', name: 'New Bot', manual: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.test/v0/grokbot/sessions')
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({ name: 'New Bot' })
    expect(settings.grokbotBots).toEqual(['New Bot'])
    expect(broadcast).toHaveBeenCalled()
    // Now listed, so the guarded routes accept it.
    await expect(handlers['grokbot:history']('New Bot')).resolves.toBeTruthy()
  })

  it('rejects invalid names before calling the API, and does not duplicate listed bots', async () => {
    const { handlers, settings, store, fetchImpl } = handlerFixture(grokBotAppData())
    await expect(handlers['grokbot:create']('   ')).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await handlers['grokbot:create']('test')).toMatchObject({ id: BOT_ID })
    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(settings.grokbotBots).toEqual([])
  })

  it('surfaces API errors when creating', async () => {
    const root = grokBotAppData()
    const { settings } = handlerFixture(root)
    const failing = new GrokBotClient(() => 'k', (async () => jsonResponse({ error: 'quota' }, 429)) as unknown as typeof fetch, () => 'https://api.test')
    const handlers = grokbotHandlers({ store: { settings, updateSettings: vi.fn() }, broadcast: vi.fn() } as unknown as IpcDeps, {
      appDataDir: () => root,
      client: failing
    })
    await expect(handlers['grokbot:create']('Ada')).rejects.toThrow(/429.*quota/)
    expect(settings.grokbotBots).toEqual([])
  })

  it('keeps native file dialogs away from remote browsers', () => {
    const { handlers } = handlerFixture(grokBotAppData())
    const remote = handlersForRemote(handlers, () => ({}) as AppState)
    expect(remote['grokbot:attachmentSave']).toBeUndefined()
    expect(remote['grokbot:attachmentReveal']).toBeUndefined()
    expect(remote['grokbot:attachmentData']).toBeDefined()
    expect(remote['grokbot:create']).toBeDefined()
  })
})
