import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mergeGrokBotMessages } from '@shared/grokbot'
import type { GrokBotCachedChat, GrokBotMessage, GrokBotTurn } from '@shared/types'
import { writeTextSafely } from './local-files'

/**
 * Recent Grok Bot messages per bot name, saved in the app's data folder so the first visit after a
 * restart shows them at once and continues with a poll. Entries belong to one API key (stored as a
 * short hash, never the key) and one session id. The file is bounded by bot count and size.
 */

const VERSION = 1
const DEFAULT_MAX_BOTS = 20
const DEFAULT_MAX_BOT_BYTES = 256 * 1024
const SAVE_DELAY_MS = 1_000

interface CachedEntry {
  account: string
  sessionId: string
  cursor: string
  turn?: GrokBotTurn
  messages: GrokBotMessage[]
  truncated?: boolean
  savedAt: number
}

interface CacheFile {
  version: number
  bots: Record<string, CachedEntry>
}

/** A stable, non-reversible tag for the API key, so another account's messages are never reused. */
export function accountTag(apiKey: string): string {
  return apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : ''
}

function validMessage(m: any): m is GrokBotMessage {
  return !!m && typeof m === 'object' && typeof m.seq === 'string' && typeof m.updatedSeq === 'string' && (m.role === 'user' || m.role === 'bot') && typeof m.text === 'string'
}

function validEntry(e: any): e is CachedEntry {
  return !!e && typeof e === 'object' && typeof e.account === 'string' && typeof e.sessionId === 'string' && typeof e.cursor === 'string' && Array.isArray(e.messages)
}

export class GrokBotChatCache {
  private data: CacheFile | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly file: () => string,
    private readonly limits: { maxBots?: number; maxBotBytes?: number } = {},
    private readonly now: () => number = Date.now
  ) {}

  private load(): CacheFile {
    if (this.data) return this.data
    let parsed: any
    try {
      parsed = JSON.parse(fs.readFileSync(this.file(), 'utf8'))
    } catch {
      parsed = undefined
    }
    const bots: Record<string, CachedEntry> = {}
    if (parsed?.version === VERSION && parsed.bots && typeof parsed.bots === 'object') {
      for (const [name, entry] of Object.entries(parsed.bots)) {
        if (validEntry(entry)) bots[name] = { ...entry, messages: entry.messages.filter(validMessage) }
      }
    }
    this.data = { version: VERSION, bots }
    return this.data
  }

  /** The saved chat of this name for this account, or undefined. */
  get(name: string, account: string): GrokBotCachedChat | undefined {
    if (!account) return undefined
    const entry = this.load().bots[name]
    if (!entry || entry.account !== account) return undefined
    return {
      messages: entry.messages,
      cursor: entry.cursor,
      turn: entry.turn ?? { idle: true, inFlight: false, queued: 0 },
      sessionId: entry.sessionId,
      truncated: entry.truncated
    }
  }

  /**
   * Records a page fetched after `after`. The saved cursor only advances when the page continues
   * from it (or replaces everything), so the cache never skips entries it has not seen.
   */
  update(name: string, account: string, after: string, page: { messages: GrokBotMessage[]; cursor: string; turn: GrokBotTurn; sessionId?: string; reset?: boolean }, full = false): void {
    if (!account || !page.sessionId) return
    const bots = this.load().bots
    const old = bots[name]
    const sameChat = old && old.account === account && old.sessionId === page.sessionId
    let entry: CachedEntry
    if (full || page.reset || !sameChat) {
      // A partial page for an unknown chat cannot seed the cache.
      if (!full && !page.reset) return
      entry = { account, sessionId: page.sessionId, cursor: page.cursor, turn: page.turn, messages: mergeGrokBotMessages([], page.messages), savedAt: this.now() }
    } else {
      const continues = Number(after) <= Number(old.cursor)
      entry = {
        ...old,
        cursor: continues && Number(page.cursor) > Number(old.cursor) ? page.cursor : old.cursor,
        turn: page.turn,
        messages: mergeGrokBotMessages(old.messages, page.messages),
        savedAt: this.now()
      }
    }
    bots[name] = this.bound(entry)
    this.prune()
    this.scheduleSave()
  }

  /** Replaces messages the entry already has (same seq and update), for files found later. */
  patch(name: string, account: string, messages: GrokBotMessage[]): void {
    const entry = this.load().bots[name]
    if (!entry || entry.account !== account || !messages.length) return
    const have = new Map(entry.messages.map((m) => [m.seq, m.updatedSeq]))
    const known = messages.filter((m) => have.get(m.seq) === m.updatedSeq)
    if (!known.length) return
    this.load().bots[name] = { ...entry, messages: mergeGrokBotMessages(entry.messages, known) }
    this.scheduleSave()
  }

  forget(name: string): void {
    if (!this.load().bots[name]) return
    delete this.load().bots[name]
    this.scheduleSave()
  }

  /** Drops the oldest messages until the entry fits; the view then reloads full history once. */
  private bound(entry: CachedEntry): CachedEntry {
    const max = this.limits.maxBotBytes ?? DEFAULT_MAX_BOT_BYTES
    let messages = entry.messages
    let truncated = entry.truncated
    while (messages.length > 1 && Buffer.byteLength(JSON.stringify(messages)) > max) {
      messages = messages.slice(Math.ceil(messages.length / 10))
      truncated = true
    }
    if (messages.length === 1 && Buffer.byteLength(JSON.stringify(messages)) > max) {
      messages = []
      truncated = true
    }
    return { ...entry, messages, truncated }
  }

  private prune(): void {
    const bots = this.load().bots
    const max = this.limits.maxBots ?? DEFAULT_MAX_BOTS
    const names = Object.keys(bots).sort((a, b) => bots[b].savedAt - bots[a].savedAt)
    for (const name of names.slice(max)) delete bots[name]
  }

  private scheduleSave(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, SAVE_DELAY_MS)
    this.timer.unref?.()
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.data) return
    try {
      writeTextSafely(this.file(), JSON.stringify(this.data), false)
    } catch (err) {
      console.error('[grokbot] cache save failed', err)
    }
  }
}
