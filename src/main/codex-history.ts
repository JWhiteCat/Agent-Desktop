import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AssistantItem, CliSession, Item, ToolItem } from '@shared/types'
import { parseAttachmentPrompt } from '@shared/attachment-message'
import { newId } from './id'
import { compact } from './reducer'
import { UNTITLED } from './history'
import { createForkPromptReader, parseForkPrompt, untrustedForkItems } from './fork-context'
import { parseCodexUsage, type CodexUsageTurn } from './codex-usage'

const sessionsRoot = (): string => path.join(process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex'), 'sessions')

/** Codex rollout names end with the session id. A few files keep a different id inside the header. */
const SESSION_ID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** `session_id` contains the letters id; this matches only the payload id field near the start of the file. */
const PAYLOAD_ID_IN_PREFIX = /(?<![A-Za-z_])"id"\s*:\s*"([^"\\]+)"/

let aliasRoot = ''
let rolloutAliases = new Map<string, string>()
let aliasIndex: Promise<void> | undefined

function useAliasRoot(): Map<string, string> {
  const root = sessionsRoot()
  if (root !== aliasRoot) {
    aliasRoot = root
    rolloutAliases = new Map()
    aliasIndex = undefined
  }
  return rolloutAliases
}

function sessionIdInName(filename: string): string | undefined {
  return SESSION_ID_IN_NAME.exec(filename)?.[1]
}

/** Remember a header id that is not already the filename, so later lookups skip another full scan. */
function rememberAlias(file: string, sessionId: string | undefined): void {
  if (!sessionId) return
  const named = sessionIdInName(path.basename(file))
  if (!named || named === sessionId) return
  useAliasRoot().set(sessionId, file)
}

function scheduleAliasIndex(): void {
  const aliases = useAliasRoot()
  if (aliasIndex) return
  const root = aliasRoot
  aliasIndex = indexAliasRollouts(root, aliases).then(() => undefined, () => undefined)
}

/** Header ids are in the first 2KB, so this never reads the rest of a rollout. */
async function indexAliasRollouts(root: string, aliases: Map<string, string>): Promise<void> {
  const named = walkRollouts(root).filter((file) => sessionIdInName(path.basename(file)))
  let cursor = 0
  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= named.length || sessionsRoot() !== root) return
      const file = named[index]
      const id = await readPrefixedSessionId(file)
      if (sessionsRoot() !== root) return
      const embedded = sessionIdInName(path.basename(file))
      if (id && embedded && id !== embedded) aliases.set(id, file)
    }
  }
  const width = Math.min(32, named.length)
  if (width === 0) return
  await Promise.all(Array.from({ length: width }, () => run()))
}

async function readPrefixedSessionId(file: string): Promise<string | undefined> {
  try {
    const handle = await fs.promises.open(file, 'r')
    try {
      const buf = Buffer.alloc(2048)
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      return buf.subarray(0, bytesRead).toString('utf8').match(PAYLOAD_ID_IN_PREFIX)?.[1]
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

export function scanCodexSessions(importedChatIds: Set<string>): CliSession[] {
  const root = sessionsRoot()
  if (!fs.existsSync(root)) return []
  const sessions: CliSession[] = []
  for (const file of walkRollouts(root)) {
    const head = readHead(file, 256_000)
    const meta = sessionMeta(head)
    rememberAlias(file, meta?.id)
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

/** Restore separators only when complete native messages prove a legacy concatenation. */
export function repairCodexAssistantMessages(chatId: string, items: Item[]): boolean {
  const candidates = new Map<string, AssistantItem[]>()
  for (const item of items) {
    if (item.kind !== 'assistant' || item.messageId !== undefined || !item.text) continue
    const matches = candidates.get(item.text) ?? []
    matches.push(item)
    candidates.set(item.text, matches)
  }
  if (!candidates.size) return false

  let text: string
  try {
    const file = findRollout(chatId)
    if (!file) return false
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return false
  }

  const groups = nativeAssistantGroups(parseLines(text))
  let changed = false
  for (const [savedText, matches] of candidates) {
    const repaired = nativeAssistantReplacement(groups, savedText)
    if (repaired === undefined || repaired === savedText) continue
    for (const item of matches) {
      item.text = repaired
      changed = true
    }
  }
  return changed
}

/** Event records duplicate response items; only the complete response text is authoritative. */
function nativeAssistantGroups(rows: TranscriptRow[]): string[][] {
  const groups: string[][] = []
  let current: string[] = []
  const boundary = (): void => {
    if (current.length) groups.push(current)
    current = []
  }
  let previousLine = -1
  for (const { row, line } of rows) {
    // Missing/invalid records cannot prove that two messages were adjacent.
    if (previousLine >= 0 && line > previousLine + 1) boundary()
    previousLine = line
    const payload = row?.payload
    if (row?.type === 'response_item') {
      if (payload?.type === 'message' && payload.role === 'assistant') {
        const content = payload.content
        const text = typeof content === 'string' ? content
          : Array.isArray(content) && content.every((block) => block && typeof block.text === 'string')
            ? content.map((block) => block.text).join('') : undefined
        if (text) current.push(text)
        else boundary()
      } else if (payload?.type !== 'reasoning') {
        boundary()
      }
    } else if (row?.type === 'event_msg') {
      const type = String(payload?.type ?? '')
      if (type === 'item_started' || type === 'item_completed') {
        const itemType = String(payload.item?.type ?? '').toLowerCase()
        if (itemType !== 'agentmessage' && itemType !== 'reasoning') boundary()
      } else if (type !== 'agent_message' && type !== 'token_count') {
        boundary()
      }
    }
  }
  boundary()
  return groups
}

function nativeAssistantReplacement(groups: string[][], savedText: string): string | undefined {
  if (groups.some((group) => group.includes(savedText))) return undefined
  let replacement: string | undefined
  for (const group of groups) {
    for (let start = 0; start < group.length - 1; start++) {
      let concatenated = ''
      let separated = ''
      for (let end = start; end < group.length; end++) {
        concatenated += group[end]
        separated += `${end === start ? '' : '\n\n'}${group[end]}`
        if (end > start) {
          // A repaired text is recognizable on every reload, even if a different
          // native sequence could also interpret it as an unseparated reply.
          if (separated === savedText) return undefined
          if (concatenated === savedText) {
            if (replacement !== undefined && replacement !== separated) return undefined
            replacement = separated
          }
        }
        if (!savedText.startsWith(concatenated) && !savedText.startsWith(separated)) break
      }
    }
  }
  return replacement
}

/** Repair legacy MCP cards only when the native completion record proves their status. */
export function repairCodexMcpTools(chatId: string, items: Item[]): boolean {
  const candidates = new Map<string, ToolItem[]>()
  for (const item of items) {
    if (item.kind !== 'tool' || item.tool !== 'shell') continue
    const args = item.args
    if (!args || typeof args !== 'object' || typeof args.server !== 'string' || !args.server
      || typeof args.tool !== 'string' || !args.tool || args.command !== undefined || args.cmd !== undefined) continue
    const key = JSON.stringify([item.callId, args.server, args.tool])
    const matches = candidates.get(key) ?? []
    matches.push(item)
    candidates.set(key, matches)
  }
  if (!candidates.size) return false

  let text: string
  try {
    const file = findRollout(chatId)
    if (!file) return false
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return false
  }

  let changed = false
  for (const { row } of parseLines(text)) {
    if (row?.type !== 'event_msg' || row.payload?.type !== 'item_completed') continue
    const native = row.payload.item
    if (String(native?.type ?? '').toLowerCase() !== 'mcptoolcall'
      || (native.status !== 'completed' && native.status !== 'failed')) continue
    const key = JSON.stringify([native.id ?? native.callId ?? native.call_id, native.server, native.tool])
    const matches = candidates.get(key)
    if (!matches) continue
    const status = native.status === 'failed' || native.error != null || native.result?.isError === true ? 'error' : 'success'
    for (const item of matches) {
      item.tool = `mcp.${native.server}.${native.tool}`
      item.status = status
      changed = true
    }
  }
  return changed
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
    const images = Math.max(imageCount(payload.message ?? payload.content),
      Array.isArray(payload.images) ? payload.images.length : 0,
      Array.isArray(payload.local_images) ? payload.local_images.length : 0)
    if (text || images) appendUser(items, text, timeOf(payload) ?? createdAt ?? 0, readForkPrompt, images)
  } else if (type === 'agent_message') {
    const text = textOf(payload.message ?? payload.content)
    if (text) appendAssistant(items, text)
  }
}

function pushMessage(items: Item[], payload: any, readForkPrompt: typeof parseForkPrompt, createdAt?: number): void {
  const role = String(payload?.role ?? '')
  const text = textOf(payload.content ?? payload.message)
  const images = imageCount(payload.content ?? payload.message)
  if (!text && !images) return
  if (role === 'user') appendUser(items, text, createdAt ?? 0, readForkPrompt, images)
  else if (role === 'assistant') appendAssistant(items, text)
}

function appendUser(items: Item[], raw: string, createdAt: number, readForkPrompt: typeof parseForkPrompt, images = 0): void {
  const replay = readForkPrompt(raw)
  if (replay) items.push(...untrustedForkItems(replay.items))
  const managed = parseAttachmentPrompt(replay ? replay.prompt : raw)
  const text = `${managed.prompt}${images ? `\n[${images} 张图片]` : ''}${managed.managedMessageId ? '\n[附件信息不可用]' : ''}`.trim()
  if (text || managed.managedMessageId) items.push({ id: newId(), kind: 'user', text, createdAt,
    ...(managed.managedMessageId ? { managedMessageId: managed.managedMessageId } : {}) })
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
      if (message) return parseAttachmentPrompt(parseForkPrompt(message)?.prompt ?? message).prompt
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

function imageCount(content: unknown): number {
  return Array.isArray(content) ? content.filter((part) => part?.type === 'input_image'
    || part?.type === 'image' || part?.type === 'image_url').length : 0
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
  const aliases = useAliasRoot()
  const cached = aliases.get(chatId)
  if (cached) {
    if (fs.existsSync(cached)) return cached
    aliases.delete(chatId)
  }
  // Match filenames before opening anything. Reading every rollout here blocks the
  // Codex prompt; most session ids are already in the filename, and the first record
  // is often larger than a small fixed read, so those reads both stall and miss.
  const unnamed: string[] = []
  const named = findNamedRollout(root, chatId, unnamed)
  if (named) return named
  for (const file of unnamed) {
    try {
      const meta = sessionMeta(readFirstRecord(file))
      rememberAlias(file, meta?.id)
      if (meta?.id === chatId) return file
    } catch {
      /* skip an unreadable rollout */
    }
  }
  if (SESSION_UUID.test(chatId)) scheduleAliasIndex()
  const alias = aliases.get(chatId)
  return alias && fs.existsSync(alias) ? alias : undefined
}

function findNamedRollout(dir: string, chatId: string, unnamed: string[]): string | undefined {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findNamedRollout(full, chatId, unnamed)
      if (found) return found
      continue
    }
    if (!entry.isFile() || !/^rollout-.*\.jsonl$/i.test(entry.name)) continue
    if (entry.name.includes(chatId)) return full
    if (!sessionIdInName(entry.name)) unnamed.push(full)
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

/** The session id lives in the first JSONL record, which can be far larger than 8KB. */
function readFirstRecord(file: string, max = 256_000): string {
  const fd = fs.openSync(file, 'r')
  try {
    const chunks: Buffer[] = []
    let total = 0
    const buf = Buffer.alloc(8192)
    while (total < max) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, max - total), total)
      if (n <= 0) break
      const newline = buf.subarray(0, n).indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(Buffer.from(buf.subarray(0, newline)))
        break
      }
      chunks.push(Buffer.from(buf.subarray(0, n)))
      total += n
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}
