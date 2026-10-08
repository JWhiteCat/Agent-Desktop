import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mergeGrokBotMessages } from '@shared/grokbot'
import { t as translate } from '@shared/i18n'
import type { GrokBotAttachment, GrokBotHistory, GrokBotInfo, GrokBotList, GrokBotMessage, GrokBotPoll, GrokBotTurn } from '@shared/types'
import { isPreviewType, isSha256, mimeTypeFor, type GrokBotFiles } from './grokbot-files'

/**
 * Grok Bot over the public `/v0/grokbot` session API (api.cursor.com), the same
 * routes `cursor-grokbot-agents` uses. The API cannot list bots, so the list
 * comes from the roster the Grok Bot desktop app caches on this machine plus
 * names added in Settings. The API also drops files from transcript entries;
 * those come from the app's undocumented local transcript and attachment caches.
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

/**
 * User messages and what the bot delivered to the user; its internal work is not shown.
 * Deliveries without text are kept: the API omits files, which the local cache may supply.
 */
export function toMessage(entry: RawEntry): GrokBotMessage | undefined {
  const text = typeof entry.text === 'string' ? entry.text : ''
  const role = entry.role === 'user' ? 'user' : entry.kind === 'send-message' ? 'bot' : undefined
  if (!role) return undefined
  if (role === 'user' && !text.trim()) return undefined
  return { seq: String(entry.seq), updatedSeq: String(entry.updatedSeq), role, text, createdAtMs: Number(entry.createdAtMs) || 0 }
}

/** An entry of the Grok Bot app's cached transcript, reduced to what the view needs. */
export interface ReplicaEntry {
  seq: string
  kind: string
  role?: string
  timestampMs: number
  type?: string
  attachments: Omit<GrokBotAttachment, 'available' | 'size'>[]
}

const REPLICA_KEY = /^sand\.client\.slice\.account\.(.+)\.transcript\.replicas\.(.+)$/
/** Cached and API timestamps of one entry differ by well under a second; larger gaps mean another entry. */
const MAX_REPLICA_SKEW_MS = 120_000

function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

function urlFileName(url: string): string {
  let pathname = url
  try {
    pathname = new URL(url).pathname
  } catch {
    // A bare path.
  }
  return decode(pathname.split(/[\\/]/).pop() ?? '')
}

/** Bot files are stored under their SHA-256, e.g. `.../attachments/<sha256>.svg`. */
export function replicaAttachment(url: unknown, fileName?: unknown, extra: { alt?: unknown; width?: unknown; height?: unknown } = {}): ReplicaEntry['attachments'][number] | undefined {
  if (typeof url !== 'string' || !url) return undefined
  const base = urlFileName(url)
  const stem = base.replace(/\.[^.]*$/, '').toLowerCase()
  const name = (typeof fileName === 'string' && fileName.trim()) || base || 'file'
  const mimeType = mimeTypeFor(typeof fileName === 'string' && /\.[^.]+$/.test(fileName) ? fileName : base)
  const out: ReplicaEntry['attachments'][number] = {
    sha256: isSha256(stem) ? stem : '',
    name: name.split(/[\\/]/).pop() || 'file',
    mimeType,
    kind: isPreviewType(mimeType) ? 'image' : 'file'
  }
  if (typeof extra.alt === 'string' && extra.alt) out.alt = extra.alt
  if (typeof extra.width === 'number' && extra.width > 0) out.width = extra.width
  if (typeof extra.height === 'number' && extra.height > 0) out.height = extra.height
  return out
}

export function toReplicaEntry(raw: any): ReplicaEntry | undefined {
  if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string') return undefined
  const seq = Number(raw.seq)
  if (!Number.isFinite(seq)) return undefined
  const message = raw.message && typeof raw.message === 'object' ? raw.message : undefined
  const attachments: ReplicaEntry['attachments'] = []
  if (message) {
    if (Array.isArray(message.images)) {
      for (const image of message.images) {
        const item = replicaAttachment(image?.url, image?.file_name ?? image?.fileName, image ?? {})
        if (item) attachments.push(item)
      }
    }
    if (message.type === 'attachment') {
      const item = replicaAttachment(message.url, message.file_name ?? message.fileName)
      if (item) attachments.push(item)
    }
  }
  return {
    seq: String(seq),
    kind: raw.kind,
    role: typeof raw.role === 'string' ? raw.role : undefined,
    timestampMs: Number(raw.timestampMs) || 0,
    type: typeof message?.type === 'string' ? message.type : undefined,
    attachments
  }
}

/** The Grok Bot app's cached transcript of one bot, by seq. Undefined when there is none. */
export function readReplica(appDataDir: string, botId: string): Map<string, ReplicaEntry> | undefined {
  const files = blobFiles(grokBotDataDir(appDataDir))
  const replicas = files
    .map((f) => ({ ...f, match: REPLICA_KEY.exec(f.key) }))
    .filter((f) => f.match?.[2] === botId)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (!replicas.length) return undefined
  const account = activeAccount(files)
  const chosen = (account && replicas.find((r) => sameAccount(r.match![1], account))) || replicas[0]
  const entries = readBlob(chosen.file)?.entries
  if (!Array.isArray(entries)) return undefined
  const out = new Map<string, ReplicaEntry>()
  for (const raw of entries) {
    const entry = toReplicaEntry(raw)
    if (entry) out.set(entry.seq, entry)
  }
  return out
}

/** The cached entry for this message, only when kind, role, and time agree with the API. */
export function matchReplica(message: GrokBotMessage, replica: Map<string, ReplicaEntry> | undefined): ReplicaEntry | undefined {
  const entry = replica?.get(message.seq)
  if (!entry) return undefined
  if (message.role === 'bot' ? entry.kind !== 'send-message' : entry.kind !== 'message' || entry.role !== 'user') return undefined
  if (message.createdAtMs && entry.timestampMs && Math.abs(message.createdAtMs - entry.timestampMs) > MAX_REPLICA_SKEW_MS) return undefined
  return entry
}

/** Adds cached files to bot messages and marks which bytes the attachment cache holds. */
export function attachReplica(
  messages: GrokBotMessage[],
  replica: Map<string, ReplicaEntry> | undefined,
  lookup: (sha256: string) => { size: number } | undefined = () => undefined
): GrokBotMessage[] {
  if (!replica) return messages
  return messages.map((message) => {
    if (message.role !== 'bot') return message
    const entry = matchReplica(message, replica)
    if (!entry) return message
    const attachments = entry.attachments.map((a): GrokBotAttachment => {
      const found = a.sha256 ? lookup(a.sha256) : undefined
      return found ? { ...a, available: true, size: found.size } : { ...a, available: false }
    })
    const next: GrokBotMessage = { ...message, attachments }
    if (!message.text.trim() && entry.type && entry.type !== 'text' && entry.type !== 'attachment') next.localType = entry.type
    return next
  })
}

/** Messages with files from the local cache. Bots added by hand have no cached transcript. */
export async function withAttachments(
  appDataDir: string,
  bot: Pick<GrokBotInfo, 'id' | 'manual'>,
  messages: GrokBotMessage[],
  files: GrokBotFiles
): Promise<GrokBotMessage[]> {
  if (bot.manual || !messages.some((m) => m.role === 'bot')) return messages
  const replica = readReplica(appDataDir, bot.id)
  // Messages the cached transcript no longer has keep the files saved with them.
  const matched = replica ? attachReplica(messages, replica) : messages
  const hashes = matched.flatMap((m) => m.attachments ?? []).map((a) => a.sha256).filter(Boolean)
  if (!hashes.length) return matched
  await files.ensure(hashes)
  return matched.map((m) => {
    if (!m.attachments?.length) return m
    const attachments = m.attachments.map(({ size: _size, ...a }): GrokBotAttachment => {
      files.remember(a)
      const found = a.sha256 ? files.lookup(a.sha256) : undefined
      return found ? { ...a, available: true, size: found.size } : { ...a, available: false }
    })
    return { ...m, attachments }
  })
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

  /** The bot's session, by name. The API creates a bot when the name is unknown, so callers pass known names only. */
  async sessionId(name: string): Promise<string> {
    const known = this.knownSession(name)
    if (known) return known
    const parsed = await this.request('POST', '/v0/grokbot/sessions', { name })
    if (typeof parsed?.id !== 'string' || !parsed.id) throw new GrokBotError(translate('Grok Bot 没有返回会话 id'))
    this.sessions.set(name, parsed.id)
    return parsed.id
  }

  /** The cached session id for this name under the current key, without a request. */
  knownSession(name: string): string | undefined {
    const key = this.apiKey()
    if (key !== this.sessionsKey) {
      this.sessions.clear()
      this.sessionsKey = key
    }
    return this.sessions.get(name)
  }

  /** Seeds a session id saved by an earlier run, so the slow name lookup is skipped. */
  rememberSession(name: string, id: string): void {
    if (!id || this.knownSession(name)) return
    this.sessions.set(name, id)
  }

  forgetSession(name: string): void {
    this.sessions.delete(name)
  }

  /** Opens the bot of this name, creating it when the account has none. Used only by explicit creation. */
  async create(name: string): Promise<string> {
    return this.sessionId(name)
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
    return { messages, cursor, turn, sessionId: id }
  }

  async poll(name: string, cursor: string): Promise<GrokBotPoll> {
    const id = await this.sessionId(name)
    const page = await this.entries(id, cursor || EMPTY_TRANSCRIPT_TAIL)
    return {
      messages: page.entries.map(toMessage).filter((m): m is GrokBotMessage => !!m),
      cursor: page.latestUpdatedSeq,
      turn: page.turn,
      sessionId: id
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
