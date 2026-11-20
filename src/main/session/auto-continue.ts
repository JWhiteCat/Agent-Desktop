import { getLocale } from '@shared/i18n'
import type { CliProvider } from '@shared/types'

/** A real reply can mention these errors. Only a short failure text is the dropped turn. */
const AUTO_CONTINUE_TEXT_LIMIT = 240
const CURSOR_DISCONNECT_NOTICE = 'Cursor 连接中断，正在发送「{word}」。'
const CODEX_CAPACITY_NOTICE = 'Codex 所选模型已满载，正在发送「{word}」。'

const CURSOR_RETRIABLE = /^(?:Error:\s*)?RetriableError:\s*(\S[^\r\n]*)$/
const FOLLOWING_SENTENCE = /[.!?;。！？；]\s+\S/

/**
 * Cursor marks a dropped model request with the `RetriableError` class, e.g.
 * `RetriableError: [unavailable] HTTP 502` or `RetriableError: Stream ended without turnEnded ...`.
 * The whole text has to be that one-clause failure. A reply that explains or merely mentions it is left alone.
 */
export function isCursorRetriableDisconnect(text: string | undefined): boolean {
  if (!text) return false
  const clean = text.trim()
  if (!clean || clean.length > AUTO_CONTINUE_TEXT_LIMIT) return false
  const message = CURSOR_RETRIABLE.exec(clean)?.[1]
  return !!message && !FOLLOWING_SENTENCE.test(message)
}

/**
 * Codex reports `server_is_overloaded` as `Selected model is at capacity. Please try a different model.`
 * The adapter often sends that sentence as the whole assistant reply and still stops with `end_turn`.
 * A longer reply that merely mentions it is left alone.
 */
export function isCodexModelCapacity(text: string | undefined): boolean {
  if (!text) return false
  const clean = text.trim()
  if (!clean || clean.length > AUTO_CONTINUE_TEXT_LIMIT) return false
  return /^(?:Error:\s*)?Selected model is at capacity\.?(?: Please try a different model\.)?$/.test(clean)
}

export function isAutomaticContinueFailure(provider: CliProvider, text: string | undefined): boolean {
  if (provider === 'cursor') return isCursorRetriableDisconnect(text)
  if (provider === 'codex') return isCodexModelCapacity(text)
  return false
}

/** English interface language asks the model to continue in English. */
export function automaticContinuePrompt(): string {
  return getLocale() === 'en' ? 'continue' : '继续'
}

export function automaticContinueNotice(provider: CliProvider): string {
  return provider === 'codex' ? CODEX_CAPACITY_NOTICE : CURSOR_DISCONNECT_NOTICE
}
