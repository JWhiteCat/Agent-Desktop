import { applyGrokBotPage } from '@shared/grokbot'
import type { GrokBotMessage, GrokBotTurn } from '@shared/types'

/** What the Grok Bot view last showed for a bot, kept across bot switches and leaving the view. */
export interface GrokBotChatSnapshot {
  messages: GrokBotMessage[]
  cursor: string
  turn?: GrokBotTurn
  sessionId?: string
}

const MAX_CHATS = 30
/** By bot name, the key the API uses. Insertion order doubles as recency. */
const chats = new Map<string, GrokBotChatSnapshot>()

export function cachedGrokBotChat(name: string): GrokBotChatSnapshot | undefined {
  return chats.get(name)
}

export function rememberGrokBotChat(name: string, chat: GrokBotChatSnapshot): void {
  chats.delete(name)
  chats.set(name, chat)
  while (chats.size > MAX_CHATS) chats.delete(chats.keys().next().value!)
}

export function forgetGrokBotChat(name?: string): void {
  if (name === undefined) chats.clear()
  else chats.delete(name)
}

/** A poll page applied to a snapshot: a reset replaces the messages, otherwise they merge by seq. */
export function applyGrokBotPoll(
  chat: GrokBotChatSnapshot,
  page: { messages: GrokBotMessage[]; cursor: string; turn: GrokBotTurn; sessionId?: string; reset?: boolean }
): GrokBotChatSnapshot {
  return {
    messages: applyGrokBotPage(chat.messages, page),
    cursor: page.cursor,
    turn: page.turn,
    sessionId: page.sessionId ?? chat.sessionId
  }
}
