import os from 'node:os'
import path from 'node:path'
import { parseAttachmentPrompt } from '@shared/attachment-message'
import { t as translate } from '@shared/i18n'
import type { CliSession, Item, Settings } from '@shared/types'
import type { ToolImageCapture } from '@shared/tool-images'
import { requireAntigravity, resolveAntigravity, resolveAntigravityAuth, withAntigravityAcp } from './antigravity'
import { visibleUserText } from './claude-history'
import { createForkPromptReader, untrustedForkItems } from './fork-context'
import { newId } from './id'
import { StreamReducer } from './reducer'

type Credentials = Pick<Settings, 'antigravityPath' | 'antigravityApiKey' | 'antigravityApiEndpoint'>

export async function scanAntigravitySessions(settings: Credentials, imported: Set<string>): Promise<CliSession[]> {
  const cli = resolveAntigravity(settings.antigravityPath)
  if (!cli) return []
  return withAntigravityAcp(cli, os.homedir(), resolveAntigravityAuth(settings), async (acp) => {
    const sessions = new Map<string, CliSession>()
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    do {
      const result = await acp.request('session/list', cursor ? { cursor } : {})
      for (const entry of Array.isArray(result?.sessions) ? result.sessions : []) {
        if (typeof entry?.sessionId !== 'string' || !entry.sessionId || typeof entry.cwd !== 'string' || !path.isAbsolute(entry.cwd)) continue
        const title = typeof entry.title === 'string' ? entry.title.trim() : ''
        const updatedAt = Date.parse(entry.updatedAt) || 0
        sessions.set(entry.sessionId, {
          chatId: entry.sessionId, cli: 'antigravity', cwd: entry.cwd, title: title || translate('未命名会话'),
          ...(!title ? { titleKind: 'untitled' as const } : {}),
          createdAt: Date.parse(entry.createdAt) || updatedAt,
          updatedAt, imported: imported.has(entry.sessionId)
        })
      }
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined
      if (!cursor || seenCursors.has(cursor)) break
      seenCursors.add(cursor)
    } while (cursor)
    return [...sessions.values()]
  }, undefined, 10_000).catch(() => [])
}

export async function readAntigravityTranscript(settings: Credentials, sessionId: string, cwd: string, capture?: ToolImageCapture): Promise<Item[]> {
  const cli = requireAntigravity(settings.antigravityPath)
  const items: Item[] = []
  const reducer = new StreamReducer(items, capture, 'antigravity')
  reducer.init = { sessionId, cwd }
  const readForkPrompt = createForkPromptReader()
  let user: { text: string; images: number; messageId?: string; createdAt: number } | undefined
  const finishUser = () => {
    if (!user) return
    const replay = readForkPrompt(user.text)
    if (replay) items.push(...untrustedForkItems(replay.items))
    const raw = replay?.prompt ?? user.text
    const { prompt, managedMessageId } = parseAttachmentPrompt(raw)
    const text = managedMessageId ? prompt : visibleUserText(raw)
    const images = user.images ? `\n[${user.images} 张图片]` : ''
    reducer.push({ id: newId(), kind: 'user', text: (text + images).trim(), createdAt: user.createdAt, ...(managedMessageId ? { managedMessageId } : {}) })
    user = undefined
  }

  await withAntigravityAcp(cli, cwd, resolveAntigravityAuth(settings), async (acp) => {
    await acp.request('session/load', { sessionId, cwd, mcpServers: [] })
  }, (method, params) => {
    if (method !== 'session/update' || params?.sessionId !== sessionId) return
    const update = params.update
    if (update?.sessionUpdate === 'user_message_chunk') {
      const content = update.content
      if (content?.type !== 'image' && !(content?.type === 'text' && typeof content.text === 'string')) return
      if (!user || user.messageId !== update.messageId) {
        finishUser()
        reducer.closeSegments()
        user = { text: '', images: 0, messageId: update.messageId, createdAt: Date.parse(update.timestamp) || 0 }
      }
      if (content.type === 'image') user.images++
      else user.text += content.text
    } else {
      if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'plan_update'].includes(update?.sessionUpdate)) finishUser()
      reducer.handleAcp(update)
    }
  })
  finishUser()
  reducer.closeSegments()
  reducer.abortRunningTools()
  return items
}
