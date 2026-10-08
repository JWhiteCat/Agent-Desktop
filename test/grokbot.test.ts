import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeBase32, GrokBotClient, readRoster, toMessage } from '../src/main/grokbot'
import { grokBotBusy, mergeGrokBotMessages } from '../src/shared/grokbot'

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

function appData(blobs: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-'))
  dirs.push(root)
  const dir = path.join(root, 'Grok Bot', 'sand-client-persistence')
  fs.mkdirSync(dir, { recursive: true })
  for (const [key, value] of Object.entries(blobs)) {
    fs.writeFileSync(path.join(dir, `${encodeBase32(key)}.blob`), typeof value === 'string' ? value : JSON.stringify(value))
  }
  return root
}

const rosterKey = (account: string) => `sand.client.slice.account.${account}.roster.last-roster`
const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  description: '',
  avatarColor: 'violet',
  lastEntry: { kind: 'text', text: `${name} last` },
  lastActivityAt: 1,
  ...extra
})

describe('grok bot roster', () => {
  it('decodes persistence keys', () => {
    expect(decodeBase32(encodeBase32('sand.client.slice.account.auth0%7Cuser.roster.last-roster'))).toBe(
      'sand.client.slice.account.auth0%7Cuser.roster.last-roster'
    )
  })

  it('reports a missing app or roster', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-'))
    dirs.push(empty)
    expect(readRoster(empty)).toEqual({ bots: [], reason: 'no-app' })
    expect(readRoster(appData({ 'sand.client.slice.ui-layout': { value: {} } }))).toEqual({ bots: [], reason: 'no-roster' })
    expect(readRoster(appData({ [rosterKey('a')]: 'not json' }))).toEqual({ bots: [], reason: 'unreadable' })
  })

  it('reads the active account, drops groups and hidden bots, and sorts by activity', () => {
    const root = appData({
      'sand.client.slice.client-meta.account-slot': { schemaVersion: 1, value: 'auth0|me' },
      [rosterKey('auth0%7Cother')]: { value: { rows: [row('x', 'Other')] } },
      [rosterKey('auth0%7Cme')]: {
        schemaVersion: 4,
        value: {
          rows: [
            row('1', 'Old', { lastActivityAt: 10 }),
            row('2', 'New', { lastActivityAt: 20, avatarColor: 'brown' }),
            row('3', 'Group', { isGroup: true }),
            row('4', 'Hidden', { isHiddenFromSidebar: true }),
            { id: '5' }
          ]
        }
      }
    })
    const list = readRoster(root)
    expect(list.reason).toBeUndefined()
    expect(list.bots.map((b) => b.name)).toEqual(['New', 'Old'])
    expect(list.bots[0]).toMatchObject({ id: '2', color: 'brown', lastText: 'New last', lastActivityAt: 20 })
  })
})

describe('grok bot transcript', () => {
  it('keeps user messages and deliveries with text', () => {
    expect(toMessage({ seq: '1', updatedSeq: '1', kind: 'message', role: 'user', text: 'hi', createdAtMs: 5 })).toMatchObject({ role: 'user', text: 'hi' })
    expect(toMessage({ seq: '2', updatedSeq: '2', kind: 'send-message', text: 'hello', createdAtMs: 6 })).toMatchObject({ role: 'bot' })
    expect(toMessage({ seq: '3', updatedSeq: '4', kind: 'send-message', text: '', createdAtMs: 7 })).toBeUndefined()
    expect(toMessage({ seq: '5', updatedSeq: '5', kind: 'tool', text: 'work', createdAtMs: 8 })).toBeUndefined()
  })

  it('merges updates by seq in transcript order', () => {
    const a = { seq: '2', updatedSeq: '2', role: 'bot' as const, text: 'draft', createdAtMs: 0 }
    const b = { seq: '1', updatedSeq: '1', role: 'user' as const, text: 'q', createdAtMs: 0 }
    const merged = mergeGrokBotMessages([a], [b, { ...a, updatedSeq: '3', text: 'final' }, { ...a, updatedSeq: '1', text: 'stale' }])
    expect(merged.map((m) => m.text)).toEqual(['q', 'final'])
    expect(grokBotBusy({ idle: true, inFlight: false, queued: 0 })).toBe(false)
    expect(grokBotBusy({ idle: false, inFlight: true, queued: 0 })).toBe(true)
    expect(grokBotBusy({ idle: true, inFlight: false, queued: 1 })).toBe(true)
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('grok bot client', () => {
  it('authenticates with the key, caches the session, and pages through history', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/v0/grokbot/sessions')) return jsonResponse({ id: '42', name: 'one', createdAtMs: 0, latestUpdatedSeq: '3' })
      if (url.includes('afterUpdatedSeq=-1')) {
        return jsonResponse({
          entries: [
            { seq: '1', updatedSeq: '1', kind: 'message', role: 'user', text: 'hi', createdAtMs: 1 },
            { seq: '2', updatedSeq: '2', kind: 'send-message', text: 'hello', createdAtMs: 2 }
          ],
          latestUpdatedSeq: '2',
          turn: { idle: true, inFlight: false, queued: 0 }
        })
      }
      if (url.includes('/messages')) {
        expect(JSON.parse(String(init.body))).toMatchObject({ text: 'ping' })
        return jsonResponse({ messageId: 'm', delivery: 'accepted_temporal' })
      }
      return jsonResponse({ entries: [], latestUpdatedSeq: '2', turn: { idle: true, inFlight: false, queued: 0 } })
    })
    const client = new GrokBotClient(() => 'key_123', fetchImpl as unknown as typeof fetch, () => 'https://api.test')
    const history = await client.history('one')
    expect(history.messages.map((m) => m.role)).toEqual(['user', 'bot'])
    expect(history.cursor).toBe('2')
    await client.send('one', '  ping  ')
    const sessionCalls = fetchImpl.mock.calls.filter(([url]) => url.endsWith('/v0/grokbot/sessions'))
    expect(sessionCalls).toHaveLength(1)
    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer key_123')
    expect(fetchImpl.mock.calls.some(([url]) => url === 'https://api.test/v0/grokbot/sessions/42/entries?afterUpdatedSeq=-1')).toBe(true)
  })

  it('rejects refused deliveries, API errors, and a missing key', async () => {
    const refused = new GrokBotClient(
      () => 'k',
      (async (url: string) =>
        url.endsWith('/sessions') ? jsonResponse({ id: '1' }) : jsonResponse({ messageId: 'm', delivery: 'rejected' })) as unknown as typeof fetch,
      () => 'https://api.test'
    )
    await expect(refused.send('one', 'x')).rejects.toThrow('rejected')

    const failing = new GrokBotClient(() => 'k', (async () => jsonResponse({ error: 'bad key' }, 401)) as unknown as typeof fetch, () => 'https://api.test')
    await expect(failing.history('one')).rejects.toThrow(/401.*bad key/)

    const fetchImpl = vi.fn()
    const keyless = new GrokBotClient(() => '', fetchImpl as unknown as typeof fetch)
    await expect(keyless.history('one')).rejects.toThrow('CURSOR_API_KEY')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
