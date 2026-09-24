import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliSession } from '@shared/types'

interface CliMeta {
  title?: string
  cwd?: string
  createdAtMs?: number
  updatedAtMs?: number
  hasConversation?: boolean
}

/** Cursor CLI keeps one folder per chat under ~/.cursor/chats/<workspace-hash>/<chatId>/meta.json. */
export function scanCliSessions(importedChatIds: Set<string>): CliSession[] {
  const root = path.join(os.homedir(), '.cursor', 'chats')
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
      const metaFile = path.join(wsDir, chat.name, 'meta.json')
      let meta: CliMeta
      try {
        meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      } catch {
        continue
      }
      if (!meta.cwd || meta.hasConversation === false) continue
      sessions.push({
        chatId: chat.name,
        title: meta.title?.trim() || '未命名会话',
        cwd: meta.cwd,
        createdAt: meta.createdAtMs ?? 0,
        updatedAt: meta.updatedAtMs ?? meta.createdAtMs ?? 0,
        imported: importedChatIds.has(chat.name)
      })
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}
