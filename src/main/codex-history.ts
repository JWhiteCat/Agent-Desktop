import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliSession, Item, ToolItem } from '@shared/types'
import { newId } from './id'
import { compact } from './reducer'
import { UNTITLED } from './history'
import { createForkPromptReader, parseForkPrompt } from './fork-context'
import { parseCodexUsage, type CodexUsageTurn } from './codex-usage'

const sessionsRoot = (): string => path.join(process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex'), 'sessions')

export function scanCodexSessions(importedChatIds: Set<string>): CliSession[] {
  const root = sessionsRoot()
  if (!fs.existsSync(root)) return []
  const sessions: CliSession[] = []
  for (const file of walkRollouts(root)) {
    const head = readHead(file, 256_000)
    const meta = sessionMeta(head)
    if (!meta?.id || !meta.cwd) continue
    const title = firstUserText(head)
    const stat = fs.statSync(file)
    sessions.push({
      chatId: meta.id,
      cli: 'codex',
      title: clipTitle(title || UNTITLED),
      ...(!title ? { titleKind: 'untitled' as const } : {}),
      cwd: meta.cwd,
      createdAt: meta.createdAt || Math.floor(stat.birthtimeMs || stat.mtimeMs),
      updatedAt: Math.floor(stat.mtimeMs),
      imported: importedChatIds.has(meta.id)
    })
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function codexChatUpdatedAt(chatId: string): number | undefined {
  const file = findRollout(chatId)
  if (!file) return undefined
  try {
    return Math.floor(fs.statSync(file).mtimeMs)
  } catch {
    return undefined
  }
}

export function readCodexTranscript(chatId: string): Item[] | undefined {
  const file = findRollout(chatId)
  if (!file) return undefined
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const items = transcriptItems(text)
  return items.length ? items : undefined
}

export function readCodexUsage(chatId: string): CodexUsageTurn[] | undefined {
  try {
    const file = findRollout(chatId)
    return file ? parseCodexUsage(fs.readFileSync(file, 'utf8')) : undefined
  } catch {
    return undefined
  }
}

/** Creation time narrows the service's search for this session's accounting records. */
export function readCodexSessionCreatedAt(chatId: string): number | undefined {
  try {
    const file = findRollout(chatId)
    return file ? sessionMeta(readHead(file, 256_000))?.createdAt : undefined
  } catch {
    return undefined
  }
}

interface SessionMeta {
  id?: string
  cwd?: string
  createdAt?: number
}

/** Parses a Codex rollout JSONL fixture into the same item kinds the thread view already draws. */
export function transcriptItems(text: string): Item[] {
  const rows = parseLines(text)
  const usage = parseCodexUsage(text)
  const items = itemsFrom(rows, false, usage)
  if (items.some((item) => item.kind === 'user' || item.kind === 'assistant')) return items
  return itemsFrom(rows, true, usage)
}

interface TranscriptRow { row: any; line: number }

function parseLines(text: string): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const [line, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue
    try {
      rows.push({ row: JSON.parse(raw), line })
    } catch {
      /* skip a torn line at the end of a partial read */
    }
  }
  return rows
}

function itemsFrom(rows: TranscriptRow[], events: boolean, usage: CodexUsageTurn[]): Item[] {
  const items: Item[] = []
  const tools = new Map<string, ToolItem>()
  const readForkPrompt = createForkPromptReader()
  let usageIndex = 0
  function appendUsageBefore(line: number): void {
    while (usageIndex < usage.length && usage[usageIndex].endLine < line) {
      const turn = usage[usageIndex++]
      items.push({
        id: newId(),
        kind: 'result',
        cli: 'codex',
        usageId: turn.usageId,
        usage: turn.usage,
        usageComplete: turn.completed,
        ...(turn.quotaSnapshot ? { quotaSnapshot: turn.quotaSnapshot } : {}),
        model: turn.model,
        createdAt: turn.createdAt,
        isError: turn.isError,
        durationMs: turn.completed && turn.startedAt !== undefined && turn.createdAt !== undefined && turn.createdAt >= turn.startedAt
          ? turn.createdAt - turn.startedAt
          : undefined
      })
    }
  }
  for (const { row, line } of rows) {
    appendUsageBefore(line)
    const payload = row?.payload ?? row
    const kind = String(row?.type ?? '')
    if (kind === 'session_meta') continue
    if (kind === 'event_msg') {
      if (events) pushEvent(items, payload, readForkPrompt, timeOf(row))
      continue
    }
    if (events) continue
    const itemType = String(payload?.type ?? '')
    if (itemType === 'message') {
      pushMessage(items, payload, readForkPrompt, timeOf(row))
      continue
    }
    if (itemType === 'function_call') {
      const callId = String(payload.call_id ?? payload.callId ?? newId())
      const tool: ToolItem = {
        id: newId(),
        kind: 'tool',
        callId,
        tool: String(payload.name ?? 'tool'),
        args: compact(parseArgs(payload.arguments)),
        status: 'success',
        startedAt: timeOf(row) ?? 0
      }
      tools.set(callId, tool)
      items.push(tool)
      continue
    }
    if (itemType === 'function_call_output') {
      const callId = String(payload.call_id ?? payload.callId ?? '')
      const tool = tools.get(callId)
      if (!tool) continue
      const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '')
      tool.result = compact({ success: { stdout: output } })
      tool.status = 'success'
    }
  }
  appendUsageBefore(Infinity)
  return items
}

function pushEvent(items: Item[], payload: any, readForkPrompt: typeof parseForkPrompt, createdAt?: number): void {
  const type = String(payload?.type ?? '')
  if (type === 'user_message') {
    const text = textOf(payload.message ?? payload.content)
    if (text) appendUser(items, text, timeOf(payload) ?? createdAt ?? 0, readForkPrompt)
  } else if (type === 'agent_message') {
    const text = textOf(payload.message ?? payload.content)
    if (text) appendAssistant(items, text)
  }
}

function pushMessage(items: Item[], payload: any, readForkPrompt: typeof parseForkPrompt, createdAt?: number): void {
  const role = String(payload?.role ?? '')
  const text = textOf(payload.content ?? payload.message)
  if (!text) return
  if (role === 'user') appendUser(items, text, createdAt ?? 0, readForkPrompt)
  else if (role === 'assistant') appendAssistant(items, text)
}

function appendUser(items: Item[], raw: string, createdAt: number, readForkPrompt: typeof parseForkPrompt): void {
  const replay = readForkPrompt(raw)
  if (replay) items.push(...replay.items)
  const text = replay ? replay.prompt : raw
  if (text) items.push({ id: newId(), kind: 'user', text, createdAt })
}

function appendAssistant(items: Item[], text: string): void {
  const last = items[items.length - 1]
  if (last?.kind === 'assistant') last.text += `\n\n${text}`
  else items.push({ id: newId(), kind: 'assistant', text })
}

function sessionMeta(text: string): SessionMeta | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const payload = row?.type === 'session_meta' ? row.payload : row?.payload?.type === 'session_meta' ? row.payload : undefined
    if (!payload || typeof payload !== 'object') continue
    const id = typeof payload.id === 'string' ? payload.id : undefined
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined
    return { id, cwd, createdAt: timeOf(payload) ?? timeOf(row) }
  }
  return undefined
}

function firstUserText(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('user')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const payload = row?.payload ?? row
    if (payload?.type === 'user_message' || (payload?.type === 'message' && payload?.role === 'user') || payload?.role === 'user') {
      const message = textOf(payload.message ?? payload.content)
      if (message) return parseForkPrompt(message)?.prompt ?? message
    }
  }
  return ''
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const row = block as { type?: string; text?: string }
    if (typeof row.text === 'string' && row.text.trim()) parts.push(row.text.trim())
  }
  return parts.join('\n').trim()
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {}
  try {
    return JSON.parse(raw)
  } catch {
    return { input: raw }
  }
}

function timeOf(row: any): number | undefined {
  const raw = row?.timestamp ?? row?.createdAt ?? row?.created_at
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? Math.floor(raw * 1000) : Math.floor(raw)
  if (typeof raw === 'string') {
    const ms = Date.parse(raw)
    if (!Number.isNaN(ms)) return ms
  }
  return undefined
}

function clipTitle(text: string): string {
  const line = text.split(/\r?\n/).find((part) => part.trim()) ?? UNTITLED
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}

function findRollout(chatId: string): string | undefined {
  const root = sessionsRoot()
  if (!fs.existsSync(root)) return undefined
  for (const file of walkRollouts(root)) {
    if (path.basename(file).includes(chatId)) return file
    const meta = sessionMeta(readHead(file, 8192))
    if (meta?.id === chatId) return file
  }
  return undefined
}

function walkRollouts(dir: string): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkRollouts(full))
    else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) out.push(full)
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
