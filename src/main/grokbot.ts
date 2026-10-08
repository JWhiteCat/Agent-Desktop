import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mergeGrokBotMessages } from '@shared/grokbot'
import { t as translate } from '@shared/i18n'
import type { GrokBotHistory, GrokBotInfo, GrokBotList, GrokBotMessage, GrokBotPoll, GrokBotTurn } from '@shared/types'

/**
 * Grok Bot over the public `/v0/grokbot` session API (api.cursor.com), the same
 * routes `cursor-grokbot-agents` uses. The API cannot list bots, so the list
 * comes from the roster the Grok Bot desktop app caches on this machine.
 */

const DEFAULT_API_URL = 'https://api.cursor.com'
const REQUEST_TIMEOUT_MS = 60_000
const EMPTY_TRANSCRIPT_TAIL = '-1'
const MAX_PAGES = 50
const PERSISTENCE_DIR = 'sand-client-persistence'
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export class GrokBotError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'GrokBotError'
  }
}

/** Blob file names are the persistence key in unpadded lowercase base32. */
export function decodeBase32(text: string): string {
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of text.toLowerCase()) {
    const index = BASE32.indexOf(ch)
    if (index < 0) break
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

function grokBotDataDir(appDataDir: string): string {
  return path.join(appDataDir, 'Grok Bot', PERSISTENCE_DIR)
}

interface BlobFile {
  key: string
  file: string
  mtimeMs: number
}

function blobFiles(dir: string): BlobFile[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: BlobFile[] = []
  for (const name of names) {
    if (!name.endsWith('.blob')) continue
    const file = path.join(dir, name)
    try {
      out.push({ key: decodeBase32(name.slice(0, -'.blob'.length)), file, mtimeMs: fs.statSync(file).mtimeMs })
    } catch {
      // Removed while scanning.
    }
  }
  return out
}

function readBlob(file: string): any {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return parsed && typeof parsed === 'object' && 'value' in parsed ? parsed.value : parsed
  } catch {
    return undefined
  }
}

const ROSTER_KEY = /^sand\.client\.slice\.account\.(.+)\.roster\.last-roster$/

function activeAccount(files: BlobFile[]): string | undefined {
  const slot = files.find((f) => f.key === 'sand.client.slice.client-meta.account-slot')
  if (!slot) return undefined
  const value = readBlob(slot.file)
  const raw = typeof value === 'string' ? value : value?.accountKey ?? value?.account ?? value?.slot ?? value?.id
  return typeof raw === 'string' && raw ? raw : undefined
}

function sameAccount(rosterAccount: string, wanted: string): boolean {
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  return decode(rosterAccount) === decode(wanted)
}

function toBot(row: any): GrokBotInfo | undefined {
  if (!row || typeof row !== 'object') return undefined
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || !row.name.trim()) return undefined
  if (row.isGroup === true || row.isHiddenFromSidebar === true) return undefined
  const lastText = typeof row.lastEntry?.text === 'string' ? row.lastEntry.text : ''
  return {
    id: row.id,
    name: row.name,
    description: typeof row.description === 'string' ? row.description : '',
    color: typeof row.avatarColor === 'string' ? row.avatarColor : '',
    lastText,
    lastActivityAt: typeof row.lastActivityAt === 'number' ? row.lastActivityAt : 0
  }
}

/** Bots of the account signed in to the Grok Bot desktop app, most recently active first. */
export function readRoster(appDataDir: string): GrokBotList {
  const files = blobFiles(grokBotDataDir(appDataDir))
  if (!files.length) return { bots: [], reason: 'no-app' }
  const rosters = files
    .map((f) => ({ ...f, account: ROSTER_KEY.exec(f.key)?.[1] }))
    .filter((f): f is BlobFile & { account: string } => !!f.account)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (!rosters.length) return { bots: [], reason: 'no-roster' }
  const account = activeAccount(files)
  const chosen = (account && rosters.find((r) => sameAccount(r.account, account))) || rosters[0]
  const rows = readBlob(chosen.file)?.rows
  if (!Array.isArray(rows)) return { bots: [], reason: 'unreadable' }
  const bots = rows.map(toBot).filter((b): b is GrokBotInfo => !!b)
  bots.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return { bots }
}

export interface RawEntry {
  seq: string
  updatedSeq: string
  kind: string
  role?: string
  text?: string
  createdAtMs: number
}

interface EntriesPage {
  entries: RawEntry[]
  latestUpdatedSeq: string
  turn: GrokBotTurn
}

/** User messages and what the bot delivered to the user; its internal work is not shown. */
export function toMessage(entry: RawEntry): GrokBotMessage | undefined {
  const text = typeof entry.text === 'string' ? entry.text : ''
  if (!text.trim()) return undefined
  const role = entry.role === 'user' ? 'user' : entry.kind === 'send-message' ? 'bot' : undefined
  if (!role) return undefined
  return { seq: String(entry.seq), updatedSeq: String(entry.updatedSeq), role, text, createdAtMs: Number(entry.createdAtMs) || 0 }
}

function apiErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error ?? parsed?.message
    if (typeof message === 'string' && message) return message
  } catch {
    // Not JSON.
  }
  return text.slice(0, 300)
}

function toTurn(raw: any): GrokBotTurn {
  return { idle: raw?.idle !== false, inFlight: raw?.inFlight === true, queued: Number(raw?.queued) || 0 }
}

export class GrokBotClient {
  private readonly sessions = new Map<string, string>()
  private sessionsKey = ''

  constructor(
    private readonly apiKey: () => string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: () => string = () => (process.env.CURSOR_API_BASE_URL ?? DEFAULT_API_URL).replace(/\/+$/, '')
  ) {}

  /** The bot's session, by name. The API creates a bot when the name is unknown, so callers pass roster names only. */
  async sessionId(name: string): Promise<string> {
    const key = this.apiKey()
    if (key !== this.sessionsKey) {
      this.sessions.clear()
      this.sessionsKey = key
    }
    const known = this.sessions.get(name)
    if (known) return known
    const parsed = await this.request('POST', '/v0/grokbot/sessions', { name })
    if (typeof parsed?.id !== 'string' || !parsed.id) throw new GrokBotError(translate('Grok Bot 没有返回会话 id'))
    this.sessions.set(name, parsed.id)
    return parsed.id
  }

  async history(name: string): Promise<GrokBotHistory> {
    const id = await this.sessionId(name)
    let cursor = EMPTY_TRANSCRIPT_TAIL
    let messages: GrokBotMessage[] = []
    let turn: GrokBotTurn = { idle: true, inFlight: false, queued: 0 }
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await this.entries(id, cursor)
      turn = page.turn
      messages = mergeGrokBotMessages(messages, page.entries.map(toMessage).filter((m): m is GrokBotMessage => !!m))
      const advanced = page.latestUpdatedSeq !== cursor
      cursor = page.latestUpdatedSeq
      if (!page.entries.length || !advanced) break
    }
    return { messages, cursor, turn }
  }

  async poll(name: string, cursor: string): Promise<GrokBotPoll> {
    const page = await this.entries(await this.sessionId(name), cursor || EMPTY_TRANSCRIPT_TAIL)
    return {
      messages: page.entries.map(toMessage).filter((m): m is GrokBotMessage => !!m),
      cursor: page.latestUpdatedSeq,
      turn: page.turn
    }
  }

  async send(name: string, text: string): Promise<void> {
    const body = text.trim()
    if (!body) throw new GrokBotError(translate('消息不能为空'))
    const id = await this.sessionId(name)
    const parsed = await this.request('POST', `/v0/grokbot/sessions/${encodeURIComponent(id)}/messages`, { text: body, messageId: randomUUID() })
    const delivery = parsed?.delivery
    if (delivery !== 'accepted_temporal' && delivery !== 'duplicate') {
      throw new GrokBotError(translate('Grok Bot 没有接收这条消息（{delivery}）', { delivery: String(delivery) }))
    }
  }

  async interrupt(name: string): Promise<void> {
    const id = await this.sessionId(name)
    await this.request('POST', `/v0/grokbot/sessions/${encodeURIComponent(id)}/interrupt`, { reason: 'Interrupted from Agent Desktop.' })
  }

  private async entries(id: string, after: string): Promise<EntriesPage> {
    const parsed = await this.request('GET', `/v0/grokbot/sessions/${encodeURIComponent(id)}/entries?afterUpdatedSeq=${encodeURIComponent(after)}`)
    return {
      entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
      latestUpdatedSeq: typeof parsed?.latestUpdatedSeq === 'string' ? parsed.latestUpdatedSeq : after,
      turn: toTurn(parsed?.turn)
    }
  }

  private async request(method: 'GET' | 'POST', route: string, body?: unknown): Promise<any> {
    const key = this.apiKey()
    if (!key) throw new GrokBotError(translate('Grok Bot 需要 Cursor API Key。请在设置 → CLI → Cursor 中填写，或设置环境变量 CURSOR_API_KEY。'), 401)
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      'x-cursor-client-type': 'agent-serve',
      'x-request-id': randomUUID()
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl()}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (err) {
      throw new GrokBotError(translate('Grok Bot 请求失败：{message}', { message: err instanceof Error ? err.message : String(err) }))
    }
    const text = await response.text()
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.sessions.clear()
      throw new GrokBotError(translate('Grok Bot 请求失败（{status}）：{message}', { status: response.status, message: apiErrorMessage(text) }), response.status)
    }
    try {
      return text ? JSON.parse(text) : {}
    } catch {
      throw new GrokBotError(translate('Grok Bot 返回了无法解析的内容'))
    }
  }
}
