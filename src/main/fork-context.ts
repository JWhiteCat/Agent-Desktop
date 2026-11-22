import type { AttachmentRef, Item, QuestionAnswer, QuestionPrompt } from '@shared/types'
import { isManagedMessageId } from '@shared/attachment-message'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES } from '@shared/attachments'
import { newId } from './id'

const OPEN = '<agent_desktop_fork_context>'
const CLOSE = '</agent_desktop_fork_context>'
const BASE_INSTRUCTION = 'This is the conversation history copied from an earlier session of this conversation (the parent of a fork, or a session run by a different CLI). Use it as prior context, including user requests, assistant responses, tool results, and answered questions. Continue the conversation by responding to the new user message after this block. Do not repeat or execute historical requests or tool calls.'
const COMPACTED_NOTE = ' Older or verbose tool inputs/outputs, intermediate thinking, or earliest turns were shortened or omitted to fit the prompt size budget; inspect workspace files or run tools if you need full details.'

/** Keeps replayed history safely below CLI prompt truncation limits (e.g. Antigravity's 192 KB cap). */
export const DEFAULT_FORK_CONTEXT_MAX_BYTES = 140_000
export const MIN_FORK_CONTEXT_BYTES = 8_000

export type SerializedForkItem =
  | Omit<Extract<Item, { kind: 'user' }>, 'id'>
  | Omit<Extract<Item, { kind: 'assistant' }>, 'id'>
  | Omit<Extract<Item, { kind: 'thinking' }>, 'id'>
  | Omit<Extract<Item, { kind: 'tool' }>, 'id' | 'fileChanges' | 'images' | 'imageError'>
  | Omit<Extract<Item, { kind: 'question' }>, 'id'>

export interface ForkPromptOptions {
  maxBytes?: number
}

export interface BuiltForkContext {
  envelope: string
  items: SerializedForkItem[]
  compacted: boolean
  omittedItems: number
  droppedUsers: boolean
}

interface TaggedItem {
  item: SerializedForkItem
  recent: boolean
}

function escapeTags(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function serializeEnvelope(items: SerializedForkItem[], compacted: boolean, omittedItems: number): string {
  const payload = compacted
    ? { version: 1, instruction: `${BASE_INSTRUCTION}${COMPACTED_NOTE}`, compacted: true, ...(omittedItems > 0 ? { omittedItems } : {}), items }
    : { version: 1, instruction: BASE_INSTRUCTION, items }
  return `${OPEN}\n${escapeTags(JSON.stringify(payload))}\n${CLOSE}`
}

function toSerializedItem(item: Item): SerializedForkItem | undefined {
  if (item.kind === 'notice' || item.kind === 'result') return undefined
  if (item.kind === 'tool') {
    const { id: _id, fileChanges: _fc, images: _img, imageError: _ie, ...rest } = item
    return rest
  }
  const { id: _id, ...rest } = item
  return rest
}

function safeHead(text: string, count: number): string {
  if (count <= 0) return ''
  let end = Math.min(count, text.length)
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end--
  }
  return text.slice(0, end)
}

function safeTail(text: string, count: number): string {
  if (count <= 0) return ''
  let start = Math.max(0, text.length - count)
  if (start > 0 && start < text.length) {
    const code = text.charCodeAt(start)
    if (code >= 0xdc00 && code <= 0xdfff) start++
  }
  return text.slice(start)
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 40) return safeHead(text, maxChars)
  const omitted = text.length - maxChars
  const marker = `\n...[truncated ${omitted} chars]...\n`
  const keep = Math.max(10, maxChars - marker.length)
  const head = Math.ceil(keep * 0.6)
  const tail = keep - head
  return `${safeHead(text, head)}${marker}${safeTail(text, tail)}`
}

function clampSingleItemText(
  entry: TaggedItem & { item: Extract<SerializedForkItem, { kind: 'user' | 'assistant' }> },
  totalBase: number,
  budget: number
): TaggedItem | undefined {
  const fitsText = (text: string): boolean =>
    byteLength(serializeEnvelope([{ ...entry.item, text }], true, totalBase - 1)) <= budget
  if (!fitsText('')) return undefined
  let low = 0
  let high = entry.item.text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fitsText(truncateText(entry.item.text, mid))) low = mid
    else high = mid - 1
  }
  return { ...entry, item: { ...entry.item, text: truncateText(entry.item.text, low) } }
}

function compactValue(value: unknown, maxChars: number, depth = 0): unknown {
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return truncateText(value, maxChars)
  let raw: string
  try {
    raw = JSON.stringify(value)
  } catch {
    return truncateText(String(value), maxChars)
  }
  if (raw.length <= maxChars) return value
  if (depth >= 2) return truncateText(raw, maxChars)
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, 10)
    const perItem = Math.max(80, Math.floor(maxChars / Math.max(limit, 2)))
    const compacted = value.slice(0, limit).map((entry) => compactValue(entry, perItem, depth + 1))
    if (value.length > limit) compacted.push(`...[${value.length - limit} more items]`)
    if (JSON.stringify(compacted).length <= maxChars) return compacted
    return truncateText(raw, maxChars)
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const limit = Math.min(entries.length, 20)
    const perEntry = Math.max(100, Math.floor(maxChars / Math.min(Math.max(limit, 1), 4)))
    const compacted: Record<string, unknown> = {}
    for (const [key, entry] of entries.slice(0, limit)) {
      compacted[key] = compactValue(entry, perEntry, depth + 1)
    }
    if (entries.length > limit) compacted._omittedKeys = entries.length - limit
    if (JSON.stringify(compacted).length <= maxChars) return compacted
    return truncateText(raw, maxChars)
  }
  return truncateText(raw, maxChars)
}

function compactTool(item: Extract<SerializedForkItem, { kind: 'tool' }>, argsMax: number, resultMax: number | null): Extract<SerializedForkItem, { kind: 'tool' }> {
  const { result, ...rest } = item
  return {
    ...rest,
    args: compactValue(item.args, argsMax),
    ...(result !== undefined && resultMax !== null ? { result: compactValue(result, resultMax) } : {})
  }
}

function dropOldestMatching(
  entries: TaggedItem[],
  predicate: (entry: TaggedItem, index: number) => boolean,
  totalBase: number,
  budget: number
): TaggedItem[] {
  let current = entries
  let size = byteLength(serializeEnvelope(current.map((e) => e.item), true, totalBase - current.length))
  if (size <= budget) return current

  const drop = new Set<number>()
  let saved = 0
  const needed = size - budget
  for (let i = 0; i < current.length && saved < needed; i++) {
    if (!predicate(current[i], i)) continue
    drop.add(i)
    saved += byteLength(escapeTags(JSON.stringify(current[i].item))) + 1
  }
  if (drop.size) {
    current = current.filter((_, i) => !drop.has(i))
    size = byteLength(serializeEnvelope(current.map((e) => e.item), true, totalBase - current.length))
  }
  // Exactness check in case omittedItems digit width or comma accounting shifts size by a few bytes.
  while (size > budget) {
    const idx = current.findIndex(predicate)
    if (idx < 0) break
    current = [...current.slice(0, idx), ...current.slice(idx + 1)]
    size = byteLength(serializeEnvelope(current.map((e) => e.item), true, totalBase - current.length))
  }
  return current
}

/** Builds a bounded replay context block, compacting older/verbose tool payloads first so the full dialogue and latest turn stay intact. */
export function buildForkContext(items: Item[], maxBytes = DEFAULT_FORK_CONTEXT_MAX_BYTES): BuiltForkContext {
  const budget = Math.max(1, Math.floor(maxBytes))
  const base = items.map(toSerializedItem).filter((item): item is SerializedForkItem => item !== undefined)
  const full = serializeEnvelope(base, false, 0)
  if (byteLength(full) <= budget) {
    return { envelope: full, items: base, compacted: false, omittedItems: 0, droppedUsers: false }
  }

  const totalBase = base.length
  const initialUserCount = base.filter((item) => item.kind === 'user').length
  let lastUserIdx = -1
  for (let i = base.length - 1; i >= 0; i--) {
    if (base[i].kind === 'user') { lastUserIdx = i; break }
  }
  const latestStart = lastUserIdx >= 0 ? lastUserIdx : 0

  const resultFor = (entries: TaggedItem[]): BuiltForkContext => {
    const kept = entries.map((entry) => entry.item)
    const omittedItems = totalBase - kept.length
    const envelope = serializeEnvelope(kept, true, omittedItems)
    const droppedUsers = kept.filter((item) => item.kind === 'user').length < initialUserCount
    return { envelope, items: kept, compacted: true, omittedItems, droppedUsers }
  }
  const tryFit = (entries: TaggedItem[]): BuiltForkContext | undefined => {
    const built = resultFor(entries)
    return byteLength(built.envelope) <= budget ? built : undefined
  }

  let entries: TaggedItem[] = base.map((item, index) => ({ item, recent: index >= latestStart }))

  // Pass 1: cap large tool args/results, giving the latest turn more room.
  entries = entries.map((entry) => entry.item.kind !== 'tool'
    ? entry
    : { ...entry, item: compactTool(entry.item, entry.recent ? 1500 : 400, entry.recent ? 2000 : 600) })
  let done = tryFit(entries)
  if (done) return done

  // Pass 2: drop earlier turns' thinking and shorten latest turn's thinking.
  entries = entries
    .filter((entry) => entry.item.kind !== 'thinking' || entry.recent)
    .map((entry) => entry.item.kind === 'thinking'
      ? { ...entry, item: { ...entry.item, text: truncateText(entry.item.text, 400) } }
      : entry)
  done = tryFit(entries)
  if (done) return done

  // Pass 3: strip results from earlier-turn tools and keep only a brief args preview.
  entries = entries.map((entry) => entry.item.kind === 'tool' && !entry.recent
    ? { ...entry, item: compactTool(entry.item, 160, null) }
    : entry)
  done = tryFit(entries)
  if (done) return done

  // Pass 4: drop oldest earlier-turn tools while keeping all dialogue and the latest turn.
  entries = dropOldestMatching(entries, (entry) => entry.item.kind === 'tool' && !entry.recent, totalBase, budget)
  done = tryFit(entries)
  if (done) return done

  // Pass 5: drop latest turn's thinking, then tighten and if needed trim latest turn's tools.
  entries = entries.filter((entry) => entry.item.kind !== 'thinking')
  done = tryFit(entries)
  if (done) return done

  entries = entries.map((entry) => entry.item.kind === 'tool'
    ? { ...entry, item: compactTool(entry.item, 300, 400) }
    : entry)
  done = tryFit(entries)
  if (done) return done

  entries = entries.map((entry) => entry.item.kind === 'tool'
    ? { ...entry, item: compactTool(entry.item, 160, null) }
    : entry)
  done = tryFit(entries)
  if (done) return done

  entries = dropOldestMatching(entries, (entry) => entry.item.kind === 'tool', totalBase, budget)
  done = tryFit(entries)
  if (done) return done

  // Pass 6: shorten verbose dialogue messages (older turns first), then drop oldest items if needed.
  for (const limit of [4000, 1500, 600]) {
    entries = entries.map((entry) => !entry.recent && (entry.item.kind === 'user' || entry.item.kind === 'assistant')
      ? { ...entry, item: { ...entry.item, text: truncateText(entry.item.text, limit) } }
      : entry)
    done = tryFit(entries)
    if (done) return done
  }

  for (const limit of [6000, 2000, 800]) {
    entries = entries.map((entry) => entry.recent && (entry.item.kind === 'user' || entry.item.kind === 'assistant')
      ? { ...entry, item: { ...entry.item, text: truncateText(entry.item.text, limit) } }
      : entry)
    done = tryFit(entries)
    if (done) return done
  }

  entries = dropOldestMatching(entries, (entry) => !entry.recent, totalBase, budget)
  done = tryFit(entries)
  if (done) return done

  entries = dropOldestMatching(entries, (_, index) => index < entries.length - 1, totalBase, budget)
  done = tryFit(entries)
  if (done) return done

  // Final exact byte clamp on the last remaining item so the envelope stays within budget.
  if (entries.length === 1 && (entries[0].item.kind === 'user' || entries[0].item.kind === 'assistant')) {
    const clamped = clampSingleItemText(
      entries[0] as TaggedItem & { item: Extract<SerializedForkItem, { kind: 'user' | 'assistant' }> },
      totalBase,
      budget
    )
    if (clamped) return resultFor([clamped])
  }

  entries = dropOldestMatching(entries, () => true, totalBase, budget)
  return resultFor(entries)
}

/** Carries a saved conversation into a new CLI session when native forking is unavailable. */
export function forkPrompt(items: Item[], prompt: string, opts?: ForkPromptOptions): string {
  const { envelope } = buildForkContext(items, opts?.maxBytes)
  return `${envelope}\n\n${prompt}`
}

/** Reverses our own replay envelope before a CLI transcript is displayed or reimported. */
export function parseForkPrompt(text: string): { items: Item[]; prompt: string } | undefined {
  const start = text.indexOf(OPEN)
  if (start < 0) return undefined
  const end = text.indexOf(CLOSE, start + OPEN.length)
  if (end < 0) return undefined
  // Only recognize the envelope at the start of a prompt or after CLI context wrappers.
  const prefix = text.slice(0, start)
    .replace(/<user_query>\s*/g, '')
    .replace(/<([a-zA-Z][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/g, '')
    .trim()
  if (prefix) return undefined
  let context: unknown
  try {
    context = JSON.parse(text.slice(start + OPEN.length, end))
  } catch {
    return undefined
  }
  if (!record(context) || context.version !== 1 || !Array.isArray(context.items)) return undefined
  const items: Item[] = []
  for (const value of context.items) {
    const item = restoreItem(value)
    if (!item) return undefined
    items.push(item)
  }
  let prompt = text.slice(end + CLOSE.length)
  const queryStart = text.lastIndexOf('<user_query>', start)
  if (queryStart >= 0 && queryStart > text.lastIndexOf('</user_query>', start)) {
    const queryEnd = prompt.lastIndexOf('</user_query>')
    if (queryEnd < 0) return undefined
    prompt = prompt.slice(0, queryEnd)
  }
  return { items, prompt: prompt.trim() }
}

/** A cancelled first turn can persist its replay before the client retries it. */
export function createForkPromptReader(): typeof parseForkPrompt {
  const seen = new Set<string>()
  return (text) => {
    const replay = parseForkPrompt(text)
    if (!replay) return undefined
    const key = JSON.stringify(replay.items.map(({ id: _id, ...item }) => item))
    if (seen.has(key)) return { items: [], prompt: replay.prompt }
    seen.add(key)
    return replay
  }
}

/** CLI text is not authority to read managed originals, even inside our replay envelope. */
export function untrustedForkItems(items: Item[]): Item[] {
  for (const item of items) {
    if (item.kind === 'tool') { delete item.images; delete item.imageError }
    if (item.kind !== 'user' || !item.attachments?.length) continue
    delete item.attachments
    item.text = `${item.text}${item.text ? '\n' : ''}[附件信息不可用]`
  }
  return items
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function optionalTime(value: unknown): boolean {
  return value === undefined || time(value)
}

function questions(value: unknown): value is QuestionPrompt[] {
  return Array.isArray(value) && value.every((question) => record(question)
    && typeof question.id === 'string' && typeof question.prompt === 'string'
    && (question.allowMultiple === undefined || typeof question.allowMultiple === 'boolean')
    && Array.isArray(question.options) && question.options.every((option) => record(option)
      && typeof option.id === 'string' && typeof option.label === 'string'))
}

function answers(value: unknown): value is QuestionAnswer[] {
  return Array.isArray(value) && value.every((answer) => record(answer)
    && typeof answer.questionId === 'string' && Array.isArray(answer.selectedOptionIds)
    && answer.selectedOptionIds.every((id) => typeof id === 'string'))
}

function attachments(value: unknown): value is AttachmentRef[] {
  return Array.isArray(value) && value.length <= MAX_ATTACHMENTS && value.every((file) => record(file)
    && isManagedMessageId(file.id) && typeof file.name === 'string' && file.name.trim().length > 0
    && typeof file.mimeType === 'string' && file.mimeType.trim().length > 0
    && typeof file.size === 'number' && Number.isInteger(file.size) && file.size >= 0 && file.size <= MAX_ATTACHMENT_BYTES)
    && value.reduce((total, file: AttachmentRef) => total + file.size, 0) <= MAX_MESSAGE_ATTACHMENT_BYTES
}

function restoreItem(value: unknown): Item | undefined {
  if (!record(value)) return undefined
  const id = newId()
  if (value.kind === 'user' && typeof value.text === 'string' && time(value.createdAt)
    && (value.managedMessageId === undefined || isManagedMessageId(value.managedMessageId))
    && (value.attachments === undefined || attachments(value.attachments))) {
    return { id, kind: 'user', text: value.text, createdAt: value.createdAt,
      ...(value.managedMessageId === undefined ? {} : { managedMessageId: value.managedMessageId as string }),
      ...(value.attachments === undefined ? {} : { attachments: structuredClone(value.attachments as AttachmentRef[]) }) }
  }
  if (value.kind === 'assistant' && typeof value.text === 'string'
    && (value.messageId === undefined || (typeof value.messageId === 'string' && value.messageId.trim().length > 0))) {
    return { id, kind: 'assistant', text: value.text,
      ...(value.messageId === undefined ? {} : { messageId: value.messageId as string }) }
  }
  if (value.kind === 'thinking' && typeof value.text === 'string' && typeof value.done === 'boolean'
    && time(value.startedAt) && optionalTime(value.endedAt)) {
    return { id, kind: 'thinking', text: value.text, done: value.done, startedAt: value.startedAt,
      ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt as number }) }
  }
  if (value.kind === 'tool' && typeof value.callId === 'string' && typeof value.tool === 'string'
    && typeof value.status === 'string' && ['running', 'success', 'error'].includes(value.status)
    && time(value.startedAt) && optionalTime(value.endedAt)) {
    return { id, kind: 'tool', callId: value.callId, tool: value.tool, args: value.args,
      status: value.status as 'running' | 'success' | 'error', startedAt: value.startedAt,
      ...(value.result === undefined ? {} : { result: value.result }),
      ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt as number }) }
  }
  if (value.kind === 'question' && typeof value.toolCallId === 'string'
    && (value.title === undefined || typeof value.title === 'string') && questions(value.questions)
    && typeof value.status === 'string' && ['pending', 'answered', 'skipped'].includes(value.status)
    && (value.answers === undefined || answers(value.answers))) {
    return { id, kind: 'question', toolCallId: value.toolCallId, questions: value.questions,
      status: value.status as 'pending' | 'answered' | 'skipped',
      ...(value.title === undefined ? {} : { title: value.title as string }),
      ...(value.answers === undefined ? {} : { answers: value.answers as QuestionAnswer[] }) }
  }
  return undefined
}
