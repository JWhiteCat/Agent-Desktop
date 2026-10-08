import { t as translate } from './i18n'
import type { GrokBotInfo, GrokBotList, GrokBotMessage, GrokBotTurn } from './types'

/** Ids of bots that only exist in the Settings list. */
export const MANUAL_BOT_PREFIX = 'manual:'
/** Custom protocol that serves cached Grok Bot files by SHA-256 in the desktop window. */
export const GROKBOT_FILE_SCHEME = 'grokbot-file'
export const MAX_GROKBOT_NAME_LENGTH = 100

/** Later updates of the same entry replace it; the list stays in transcript order. */
export function mergeGrokBotMessages(current: GrokBotMessage[], incoming: GrokBotMessage[]): GrokBotMessage[] {
  if (!incoming.length) return current
  const bySeq = new Map(current.map((m) => [m.seq, m]))
  for (const m of incoming) {
    const old = bySeq.get(m.seq)
    if (!old || Number(m.updatedSeq) >= Number(old.updatedSeq)) bySeq.set(m.seq, m)
  }
  return [...bySeq.values()].sort((a, b) => Number(a.seq) - Number(b.seq))
}

/** A poll page applied to the shown messages: a reset replaces them, otherwise updates merge by seq. */
export function applyGrokBotPage(current: GrokBotMessage[], page: { messages: GrokBotMessage[]; reset?: boolean }): GrokBotMessage[] {
  return page.reset ? mergeGrokBotMessages([], page.messages) : mergeGrokBotMessages(current, page.messages)
}

export function grokBotBusy(turn: GrokBotTurn | undefined): boolean {
  return !!turn && (turn.inFlight || turn.queued > 0)
}

/** A trimmed bot name, or an error explaining why it cannot be used. */
export function validateGrokBotName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) throw new Error(translate('Bot 名称不能为空'))
  if (name.length > MAX_GROKBOT_NAME_LENGTH) throw new Error(translate('Bot 名称不能超过 {count} 个字符', { count: MAX_GROKBOT_NAME_LENGTH }))
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error(translate('Bot 名称不能包含控制字符'))
  return name
}

/** Valid, unique names in their saved order. Invalid entries are dropped. */
export function normalizeGrokBotNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    let name: string
    try {
      name = validateGrokBotName(item)
    } catch {
      continue
    }
    if (!out.includes(name)) out.push(name)
  }
  return out
}

export function manualGrokBot(name: string): GrokBotInfo {
  return { id: `${MANUAL_BOT_PREFIX}${name}`, name, description: '', color: 'gray', lastText: '', lastActivityAt: 0, manual: true }
}

/** Roster bots first, then manual names the roster does not already have. */
export function mergeManualGrokBots(list: GrokBotList, names: string[]): GrokBotList {
  const known = new Set(list.bots.map((b) => b.name))
  const manual = normalizeGrokBotNames(names).filter((name) => !known.has(name)).map(manualGrokBot)
  return { ...list, bots: [...list.bots, ...manual] }
}

/** Bot messages whose files may still appear in the local cache. */
export function unresolvedGrokBotMessages(messages: GrokBotMessage[], since: number): GrokBotMessage[] {
  return messages.filter((m) => m.role === 'bot' && m.attachments === undefined && m.createdAtMs >= since)
}

export function grokBotFileUrl(sha256: string): string {
  return `${GROKBOT_FILE_SCHEME}://${sha256}/`
}
