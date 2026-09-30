import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliSession, Item, ToolItem } from '@shared/types'
import { newId } from './id'
import { UNTITLED } from './history'
import { compact } from './reducer'
import { createForkPromptReader, parseForkPrompt } from './fork-context'

const CLIENT_BLOCK = /<agent_desktop_client\b[^>]*>[\s\S]*?<\/agent_desktop_client>/gi

export function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

export function scanClaudeSessions(importedChatIds: Set<string>, root = projectsRoot()): CliSession[] {
  if (!fs.existsSync(root)) return []
  const sessions: CliSession[] = []
  for (const file of walkSessions(root)) {
    const head = readHead(file, 256_000)
    const meta = sessionMeta(head, file)
    if (!meta?.id || !meta.cwd) continue
    const stat = fs.statSync(file)
    sessions.push({
      chatId: meta.id,
      cli: 'claude',
      title: clipTitle(meta.title || UNTITLED),
      ...(!meta.title ? { titleKind: 'untitled' as const } : {}),
      cwd: meta.cwd,
      createdAt: meta.createdAt || Math.floor(stat.birthtimeMs || stat.mtimeMs),
      updatedAt: Math.floor(stat.mtimeMs),
      imported: importedChatIds.has(meta.id)
    })
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function claudeChatUpdatedAt(chatId: string, root = projectsRoot()): number | undefined {
  const file = findSession(chatId, root)
  if (!file) return undefined
  try {
    return Math.floor(fs.statSync(file).mtimeMs)
  } catch {
    return undefined
  }
}

export function readClaudeTranscript(chatId: string, root = projectsRoot()): Item[] | undefined {
  const file = findSession(chatId, root)
  if (!file) return undefined
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const items = claudeTranscriptItems(text)
  return items.length ? items : undefined
}

/** Parses a Claude Code JSONL transcript into the item kinds the thread view already draws. */
export function claudeTranscriptItems(text: string): Item[] {
  const items: Item[] = []
  const tools = new Map<string, ToolItem>()
  const readForkPrompt = createForkPromptReader()
  for (const row of parseLines(text)) {
    if (row?.isSidechain) continue
    const type = String(row?.type ?? '')
    if (type !== 'user' && type !== 'assistant') continue
    const createdAt = timeOf(row) ?? 0
    const blocks = messageBlocks(row?.message)
    if (type === 'user') pushUser(items, tools, blocks, createdAt, readForkPrompt)
    else pushAssistant(items, tools, blocks, createdAt)
  }
  return items
}

function pushUser(items: Item[], tools: Map<string, ToolItem>, blocks: any[], createdAt: number, readForkPrompt: typeof parseForkPrompt): void {
  const textParts: string[] = []
  for (const block of blocks) {
    if (block?.type === 'tool_result') {
      applyToolResult(tools, block)
      continue
    }
    const text = blockText(block)
    if (text) textParts.push(text)
  }
  const raw = textParts.join('\n')
  const replay = readForkPrompt(raw)
  if (replay) items.push(...replay.items)
  const text = replay ? replay.prompt : visibleUserText(raw)
  if (text) items.push({ id: newId(), kind: 'user', text, createdAt })
}

function pushAssistant(items: Item[], tools: Map<string, ToolItem>, blocks: any[], createdAt: number): void {
  for (const block of blocks) {
    const type = String(block?.type ?? '')
    if (type === 'thinking' || type === 'reasoning' || type === 'redacted_thinking') {
      const text = typeof block?.thinking === 'string' ? block.thinking : blockText(block)
      if (text.trim()) items.push({ id: newId(), kind: 'thinking', text, done: true, startedAt: createdAt })
      continue
    }
    if (type === 'tool_use') {
      const callId = String(block.id ?? newId())
      const tool: ToolItem = {
        id: newId(),
        kind: 'tool',
        callId,
        tool: String(block.name ?? 'tool'),
        args: compact(block.input ?? {}),
        status: 'error',
        startedAt: createdAt
      }
      tools.set(callId, tool)
      items.push(tool)
      continue
    }
    const text = blockText(block)
    if (!text.trim()) continue
    const last = items[items.length - 1]
    if (last?.kind === 'assistant') last.text += `\n\n${text}`
    else items.push({ id: newId(), kind: 'assistant', text })
  }
}

function applyToolResult(tools: Map<string, ToolItem>, block: any): void {
  const callId = String(block.tool_use_id ?? block.toolUseId ?? '')
  const tool = tools.get(callId)
  if (!tool) return
  const text = toolResultText(block.content ?? block.output)
  const isError = block.is_error === true || block.isError === true
  tool.result = compact(isError ? { error: text } : { success: { stdout: text } })
  tool.status = isError ? 'error' : 'success'
  tool.endedAt = tool.startedAt
}

/** Drops the plan-mode client hint and keeps the text the person typed. */
export function visibleUserText(raw: string): string {
  const replay = parseForkPrompt(raw)
  if (replay) return replay.prompt
  const query = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
  const body = query ? query[1] : raw
  return body.replace(CLIENT_BLOCK, '').trim()
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  return content
    .map((part) => (typeof part === 'string' ? part : blockText(part)))
    .filter(Boolean)
    .join('\n')
}

function blockText(block: any): string {
  if (!block || typeof block !== 'object') return ''
  if (typeof block.text === 'string') return block.text
  if (typeof block.thinking === 'string') return block.thinking
  return ''
}

function messageBlocks(message: any): any[] {
  const content = message?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

interface SessionMeta {
  id?: string
  cwd?: string
  title?: string
  createdAt?: number
}

function sessionMeta(text: string, file: string): SessionMeta | undefined {
  const idFromName = path.basename(file, '.jsonl')
  let id = ''
  let cwd = ''
  let title = ''
  let createdAt: number | undefined
  for (const row of parseLines(text)) {
    if (!id && typeof row?.sessionId === 'string') id = row.sessionId
    if (!cwd && typeof row?.cwd === 'string') cwd = row.cwd
    if (createdAt === undefined) createdAt = timeOf(row)
    if (!title && row?.type === 'user' && !row?.isSidechain) {
      const textParts = messageBlocks(row.message)
        .filter((block) => block?.type !== 'tool_result')
        .map((block) => visibleUserText(blockText(block)))
        .filter(Boolean)
      if (textParts.length) title = textParts.join('\n')
    }
    if (id && cwd && title) break
  }
  if (!id && /^[0-9a-f-]{8,}$/i.test(idFromName)) id = idFromName
  if (!id) return undefined
  return { id, cwd, title, createdAt }
}

function parseLines(text: string): any[] {
  const rows: any[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* skip a torn line at the end of a partial read */
    }
  }
  return rows
}

function findSession(chatId: string, root: string): string | undefined {
  if (!fs.existsSync(root)) return undefined
  const target = `${chatId}.jsonl`
  for (const file of walkSessions(root)) {
    if (path.basename(file) === target) return file
  }
  return undefined
}

function walkSessions(dir: string): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'subagents') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkSessions(full))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

function readHead(file: string, max: number): string {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(max)
    const n = fs.readSync(fd, buf, 0, max, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function timeOf(row: any): number | undefined {
  const raw = row?.timestamp ?? row?.createdAt
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? Math.floor(raw * 1000) : Math.floor(raw)
  if (typeof raw === 'string') {
    const ms = Date.parse(raw)
    if (!Number.isNaN(ms)) return ms
  }
  return undefined
}

function clipTitle(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? UNTITLED
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}
