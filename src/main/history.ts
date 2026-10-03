import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CliSession, Item, ToolItem } from '@shared/types'
import { parseAttachmentPrompt } from '@shared/attachment-message'
import { newId } from './id'
import { compact } from './reducer'
import { createForkPromptReader, untrustedForkItems } from './fork-context'

interface CliMeta {
  title?: string
  cwd?: string
  createdAtMs?: number
  updatedAtMs?: number
  hasConversation?: boolean
}

export const UNTITLED = '未命名会话'

const chatsRoot = (): string => path.join(os.homedir(), '.cursor', 'chats')

/** Cursor CLI keeps one folder per chat under ~/.cursor/chats/<workspace-hash>/<chatId>/meta.json. */
export function scanCliSessions(importedChatIds: Set<string>): CliSession[] {
  const root = chatsRoot()
  if (!fs.existsSync(root)) return []
  const sessions: CliSession[] = []
  for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const wsDir = path.join(root, ws.name)
    let chats: fs.Dirent[]
    try {
      chats = fs.readdirSync(wsDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const chat of chats) {
      if (!chat.isDirectory()) continue
      const meta = readMetaFile(path.join(wsDir, chat.name))
      if (!meta?.cwd || meta.hasConversation === false) continue
      sessions.push({
        chatId: chat.name,
        cli: 'cursor',
        title: meta.title?.trim() || UNTITLED,
        ...(!meta.title?.trim() ? { titleKind: 'untitled' as const } : {}),
        cwd: meta.cwd,
        createdAt: meta.createdAtMs ?? 0,
        updatedAt: meta.updatedAtMs ?? meta.createdAtMs ?? 0,
        imported: importedChatIds.has(chat.name)
      })
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

function readMetaFile(chatDir: string): CliMeta | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(chatDir, 'meta.json'), 'utf8'))
  } catch {
    return undefined
  }
}

export function findChatDir(chatId: string): string | undefined {
  const root = chatsRoot()
  if (!fs.existsSync(root)) return undefined
  for (const ws of fs.readdirSync(root)) {
    const dir = path.join(root, ws, chatId)
    if (fs.existsSync(path.join(dir, 'store.db'))) return dir
  }
  return undefined
}

export function cliChatUpdatedAt(chatId: string): number | undefined {
  const dir = findChatDir(chatId)
  return dir ? readMetaFile(dir)?.updatedAtMs : undefined
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0
  let shift = 0
  for (;;) {
    const b = buf[pos++]
    if (b === undefined) throw new Error('truncated varint')
    result += (b & 0x7f) * 2 ** shift
    if (!(b & 0x80)) return [result, pos]
    shift += 7
  }
}

/** The root blob is a protobuf whose repeated field 1 lists message blob ids (sha256) in order. */
function messageIds(root: Uint8Array): string[] {
  const ids: string[] = []
  let pos = 0
  while (pos < root.length) {
    let key: number
    ;[key, pos] = readVarint(root, pos)
    const field = Math.floor(key / 8)
    const wireType = key & 7
    if (wireType === 0) {
      ;[, pos] = readVarint(root, pos)
    } else if (wireType === 2) {
      let len: number
      ;[len, pos] = readVarint(root, pos)
      if (field === 1 && len === 32) ids.push(Buffer.from(root.subarray(pos, pos + len)).toString('hex'))
      pos += len
    } else if (wireType === 1) pos += 8
    else if (wireType === 5) pos += 4
    else break
  }
  return ids
}

const CONTEXT_BLOCK = /<([a-zA-Z][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/g

function contentText(content: unknown): string {
  return typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
            .map((p: any) => p.text)
            .join('\n')
        : ''
}

function imageSuffix(content: unknown): string {
  const images = Array.isArray(content) ? content.filter((p: any) => p?.type === 'image').length : 0
  return images ? `\n[${images} 张图片]` : ''
}

/** User turns are wrapped with injected context blocks; keep only what the person typed. */
function userText(content: unknown): string {
  const raw = contentText(content)
  const suffix = imageSuffix(content)
  const query = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
  if (query) return query[1] + suffix
  const text = raw.replace(CONTEXT_BLOCK, (block: string) => block.startsWith('<agent_desktop_attachments>') ? block : '').trim()
  return text ? text + suffix : suffix.trim()
}

/** Rebuilds a readable transcript from the CLI's local chat store (message blobs are plain JSON). */
export function readCliTranscript(chatId: string): Item[] | undefined {
  const dir = findChatDir(chatId)
  if (!dir) return undefined
  const db = new DatabaseSync(path.join(dir, 'store.db'), { readOnly: true })
  try {
    const metaRow = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value: string } | undefined
    if (!metaRow) return undefined
    const meta = JSON.parse(Buffer.from(metaRow.value, 'hex').toString('utf8'))
    const getBlob = db.prepare('SELECT data FROM blobs WHERE id = ?')
    const blob = (id: string): Uint8Array | undefined => (getBlob.get(id) as { data: Uint8Array } | undefined)?.data
    const root = meta.latestRootBlobId ? blob(meta.latestRootBlobId) : undefined
    if (!root) return undefined

    const items: Item[] = []
    const tools = new Map<string, ToolItem>()
    const readForkPrompt = createForkPromptReader()
    const createdAt = readMetaFile(dir)?.createdAtMs ?? 0

    for (const id of messageIds(root)) {
      const data = blob(id)
      if (!data || data[0] !== 0x7b) continue
      let msg: any
      try {
        msg = JSON.parse(Buffer.from(data).toString('utf8'))
      } catch {
        continue
      }
      if (msg.role === 'user') {
        const replay = readForkPrompt(contentText(msg.content))
        if (replay) items.push(...untrustedForkItems(replay.items))
        const managed = parseAttachmentPrompt(replay ? replay.prompt : contentText(msg.content))
        const text = managed.managedMessageId
          ? `${managed.prompt}${imageSuffix(msg.content)}\n[附件信息不可用]`.trim()
          : replay ? replay.prompt + imageSuffix(msg.content) : userText(msg.content)
        if (text || managed.managedMessageId) items.push({ id: newId(), kind: 'user', text, createdAt,
          ...(managed.managedMessageId ? { managedMessageId: managed.managedMessageId } : {}) })
      } else if (msg.role === 'assistant') {
        const parts = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content ?? [])
        for (const part of parts) {
          if (part?.type === 'text' && part.text?.trim()) {
            const last = items[items.length - 1]
            if (last?.kind === 'assistant') last.text += `\n\n${part.text}`
            else items.push({ id: newId(), kind: 'assistant', text: part.text })
          } else if (part?.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
            items.push({ id: newId(), kind: 'thinking', text: part.text, done: true, startedAt: 0 })
          } else if (part?.type === 'tool-call') {
            const tool: ToolItem = {
              id: newId(),
              kind: 'tool',
              callId: part.toolCallId,
              tool: String(part.toolName ?? 'tool'),
              args: compact(part.args ?? {}),
              status: 'error',
              startedAt: 0
            }
            tools.set(part.toolCallId, tool)
            items.push(tool)
          }
        }
      } else if (msg.role === 'tool') {
        for (const part of Array.isArray(msg.content) ? msg.content : []) {
          if (part?.type !== 'tool-result') continue
          const tool = tools.get(part.toolCallId)
          if (!tool) continue
          const high = msg.providerOptions?.cursor?.highLevelToolCallResult
          const output = high?.output ?? { success: { result: part.result } }
          tool.result = compact(output)
          tool.status = high?.isError || output.error !== undefined ? 'error' : 'success'
        }
      }
    }
    return items
  } finally {
    db.close()
  }
}
