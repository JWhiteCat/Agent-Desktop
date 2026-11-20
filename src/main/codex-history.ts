import type { ToolImageCapture } from '@shared/tool-images'
import fs from 'node:fs'
import type { CliSession, Item, ToolItem } from '@shared/types'
import { parseAttachmentPrompt } from '@shared/attachment-message'
import { ToolFileRecorder } from './tool-file-changes'
import { newId } from './id'
import { compact } from './reducer'
import { UNTITLED } from './history'
import { createForkPromptReader, parseForkPrompt, untrustedForkItems } from './fork-context'
import { parseCodexUsage, type CodexUsageTurn } from './codex-usage'
import {
  codexSessionMeta, codexSessionsRoot, codexTimeOf, findCodexRollout,
  readRolloutHead, rememberRolloutAlias, walkRollouts
} from './codex-rollouts'
import { parseRolloutLines, type TranscriptRow } from './codex-history-repair'

export { repairCodexAssistantMessages, repairCodexMcpTools } from './codex-history-repair'

export function scanCodexSessions(importedChatIds: Set<string>): CliSession[] {
  const root = codexSessionsRoot()
  if (!fs.existsSync(root)) return []
  const sessions: CliSession[] = []
  for (const file of walkRollouts(root)) {
    const head = readRolloutHead(file, 256_000)
    const meta = codexSessionMeta(head)
    rememberRolloutAlias(file, meta?.id)
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
  const file = findCodexRollout(chatId)
  if (!file) return undefined
  try {
    return Math.floor(fs.statSync(file).mtimeMs)
  } catch {
    return undefined
  }
}

export function readCodexTranscript(chatId: string, captureImages?: ToolImageCapture): Item[] | undefined {
  const file = findCodexRollout(chatId)
  if (!file) return undefined
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const items = transcriptItems(text, captureImages)
  return items.length ? items : undefined
}

export function readCodexUsage(chatId: string): CodexUsageTurn[] | undefined {
  try {
    const file = findCodexRollout(chatId)
    return file ? parseCodexUsage(fs.readFileSync(file, 'utf8')) : undefined
  } catch {
    return undefined
  }
}

/** Creation time narrows the service's search for this session's accounting records. */
export function readCodexSessionCreatedAt(chatId: string): number | undefined {
  try {
    const file = findCodexRollout(chatId)
    return file ? codexSessionMeta(readRolloutHead(file, 256_000))?.createdAt : undefined
  } catch {
    return undefined
  }
}

/** Parses a Codex rollout JSONL fixture into the same item kinds the thread view already draws. */
export function transcriptItems(text: string, captureImages?: ToolImageCapture): Item[] {
  const rows = parseRolloutLines(text)
  const usage = parseCodexUsage(text)
  const items = itemsFrom(rows, false, usage, captureImages)
  if (items.some((item) => item.kind === 'user' || item.kind === 'assistant')) return items
  return itemsFrom(rows, true, usage, captureImages)
}

function itemsFrom(rows: TranscriptRow[], events: boolean, usage: CodexUsageTurn[], captureImages?: ToolImageCapture): Item[] {
  const items: Item[] = []
  const tools = new Map<string, ToolItem>()
  const readForkPrompt = createForkPromptReader()
  let fileRecorder = new ToolFileRecorder()
  let cwd = ''
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
    if (kind === 'session_meta') {
      if (typeof payload.cwd === 'string') cwd = payload.cwd
      continue
    }
    if (kind === 'event_msg') {
      if (events) pushEvent(items, payload, readForkPrompt, codexTimeOf(row))
      continue
    }
    if (events) continue
    const itemType = String(payload?.type ?? '')
    if (itemType === 'message') {
      if (payload.role === 'user') fileRecorder = new ToolFileRecorder()
      pushMessage(items, payload, readForkPrompt, codexTimeOf(row))
      continue
    }
    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const callId = String(payload.call_id ?? payload.callId ?? newId())
      const parsedArgs = itemType === 'custom_tool_call' ? payload.input : parseArgs(payload.arguments)
      const tool: ToolItem = {
        id: newId(),
        kind: 'tool',
        callId,
        tool: String(payload.name ?? 'tool'),
        args: compact(parsedArgs),
        status: 'running',
        startedAt: codexTimeOf(row) ?? 0
      }
      fileRecorder.record(tool, cwd, parsedArgs)
      tools.set(callId, tool)
      items.push(tool)
      continue
    }
    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      const callId = String(payload.call_id ?? payload.callId ?? '')
      const tool = tools.get(callId)
      if (!tool) continue
      const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(compact(payload.output ?? ''))
      tool.result = compact({ success: { stdout: output } })
      const failed = payload.is_error === true || /^(?:Error:|error:|Failed|Exit code: [1-9])/.test(output)
      tool.status = failed ? 'error' : 'success'
      captureImages?.(tool, payload.output)
      const patch = tool.tool.toLowerCase().replace(/[^a-z]/g, '') === 'applypatch'
      if (!patch || /^Success\. Updated the following files:/m.test(output)) {
        fileRecorder.record(tool, cwd, tool.args, typeof payload.output === 'object' ? payload.output : tool.result)
      } else {
        tool.fileChanges = []
      }
    }
  }
  appendUsageBefore(Infinity)
  for (const item of items) if (item.kind === 'tool' && item.status === 'running') { item.status = 'error'; item.fileChanges = [] }
  return items
}

function pushEvent(items: Item[], payload: any, readForkPrompt: typeof parseForkPrompt, createdAt?: number): void {
  const type = String(payload?.type ?? '')
  if (type === 'user_message') {
    const text = textOf(payload.message ?? payload.content)
    const images = Math.max(
      imageCount(payload.message ?? payload.content),
      Array.isArray(payload.images) ? payload.images.length : 0,
      Array.isArray(payload.local_images) ? payload.local_images.length : 0
    )
    if (text || images) appendUser(items, text, codexTimeOf(payload) ?? createdAt ?? 0, readForkPrompt, images)
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
  if (text || managed.managedMessageId) {
    items.push({
      id: newId(),
      kind: 'user',
      text,
      createdAt,
      ...(managed.managedMessageId ? { managedMessageId: managed.managedMessageId } : {})
    })
  }
}

function appendAssistant(items: Item[], text: string): void {
  const last = items[items.length - 1]
  if (last?.kind === 'assistant') last.text += `\n\n${text}`
  else items.push({ id: newId(), kind: 'assistant', text })
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
  return Array.isArray(content)
    ? content.filter((part) => part?.type === 'input_image' || part?.type === 'image' || part?.type === 'image_url').length
    : 0
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {}
  try {
    return JSON.parse(raw)
  } catch {
    return { input: raw }
  }
}

function clipTitle(text: string): string {
  const line = text.split(/\r?\n/).find((part) => part.trim()) ?? UNTITLED
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}
