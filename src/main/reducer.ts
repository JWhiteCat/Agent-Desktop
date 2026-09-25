import type { AssistantItem, Item, ResultItem, ThinkingItem, ToolItem } from '@shared/types'
import { normalizeTurnUsage } from '@shared/turn-usage'
import { unifiedDiff } from '@shared/unified-diff'
import { newId } from './id'

export interface InitInfo {
  sessionId?: string
  cwd?: string
  model?: string
}

const TOOL_META_KEYS = new Set(['hookAdditionalContexts', 'toolCallId', 'startedAtMs', 'completedAtMs'])
const MAX_STRING = 24_000
const DROP_KEYS = new Set(['afterFullFileContent', 'beforeFullFileContent', 'parsingResult', 'adminCommandDenylist'])

/** Tool results can embed whole files; keep persisted history small. */
export function compact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}\n… (已截断 ${value.length - MAX_STRING} 字符)` : value
  }
  if (Array.isArray(value)) {
    const arr = value.slice(0, 500).map((v) => compact(v, depth + 1))
    return value.length > 500 ? [...arr, `… (${value.length - 500} more)`] : arr
  }
  if (value && typeof value === 'object' && depth < 12) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (!DROP_KEYS.has(k)) out[k] = compact(v, depth + 1)
    }
    return out
  }
  return value
}

function textOf(message: any): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('')
}

function toolStatus(result: any): ToolItem['status'] {
  if (!result) return 'success'
  if (result.success !== undefined) return 'success'
  if (result.error !== undefined || result.failure !== undefined || result.rejected !== undefined) return 'error'
  return 'success'
}

/**
 * Folds Cursor CLI `stream-json` events into persisted thread items.
 * With `--stream-partial-output`, deltas carry `timestamp_ms` and a final
 * aggregated assistant message without it follows; the aggregate is skipped.
 */
export class StreamReducer {
  private assistant?: AssistantItem
  private thinking?: ThinkingItem
  private tools = new Map<string, ToolItem>()
  /** One Codex plan card per turn, updated by `plan` and `plan_update`. */
  private planCallId?: string
  private sawDelta = false
  init: InitInfo = {}
  gotResult = false
  lastAssistantText = ''
  lastUsage?: ResultItem['usage']

  constructor(private readonly items: Item[]) {}

  /** Returns items that were created or changed. */
  handle(ev: any): Item[] {
    switch (ev?.type) {
      case 'system':
        if (ev.subtype === 'init') {
          this.init = { sessionId: ev.session_id, cwd: ev.cwd, model: ev.model }
        }
        return []
      case 'thinking':
        return this.onThinking(ev)
      case 'assistant':
        return this.onAssistant(ev)
      case 'tool_call':
        return this.onTool(ev)
      case 'result': {
        this.gotResult = true
        const changed = this.closeSegments()
        const item: Item = {
          id: newId(),
          kind: 'result',
          isError: !!ev.is_error,
          durationMs: ev.duration_ms,
          usage: ev.usage
        }
        if (ev.is_error && typeof ev.result === 'string' && ev.result) {
          const notice: Item = { id: newId(), kind: 'notice', level: 'error', text: ev.result }
          this.items.push(notice)
          changed.push(notice)
        }
        this.items.push(item)
        return [...changed, item]
      }
      default:
        return []
    }
  }

  /** Cursor ACP `session/update` payload (`params.update`). */
  handleAcp(update: any): Item[] {
    switch (update?.sessionUpdate) {
      case 'agent_thought_chunk': {
        const text = textOfContent(update.content)
        if (!text) return []
        return this.onThinking({ subtype: 'delta', text, timestamp_ms: Date.now() })
      }
      case 'agent_message_chunk': {
        const text = textOfContent(update.content)
        if (!text) return []
        return this.onAssistant({ message: { content: text }, timestamp_ms: Date.now() })
      }
      case 'tool_call':
      case 'tool_call_update':
        return this.onAcpTool(update)
      case 'usage_update': {
        const usage = normalizeTurnUsage(update.usage)
        if (usage) this.lastUsage = usage
        return []
      }
      case 'plan_update':
        return this.onPlanMarkdown(update?.plan)
      case 'plan':
        return this.onPlanEntries(update?.entries)
      default:
        return []
    }
  }

  push(item: Item): Item {
    this.items.push(item)
    return item
  }

  closeSegments(): Item[] {
    const changed: Item[] = []
    if (this.thinking) {
      this.thinking.done = true
      this.thinking.endedAt = Date.now()
      changed.push(this.thinking)
      this.thinking = undefined
    }
    this.assistant = undefined
    return changed
  }

  /** Marks tool calls still running (e.g. after the process was killed) as failed. */
  abortRunningTools(): Item[] {
    const changed: Item[] = []
    for (const t of this.tools.values()) {
      if (t.status === 'running') {
        t.status = 'error'
        t.endedAt = Date.now()
        changed.push(t)
      }
    }
    return changed
  }

  private onPlanMarkdown(plan: any): Item[] {
    const text = typeof plan?.content === 'string' ? plan.content : ''
    if (!text.trim()) return []
    const meta = planHeading(text)
    return this.upsertPlan({ plan: text, name: meta.name, overview: meta.overview })
  }

  private onPlanEntries(entries: unknown): Item[] {
    if (!Array.isArray(entries) || entries.length === 0) return []
    const todos = entries.map((entry, index) => {
      const row = entry && typeof entry === 'object' ? (entry as { content?: unknown; status?: unknown }) : {}
      return { id: String(index), content: String(row.content ?? ''), status: String(row.status ?? 'pending') }
    })
    return this.upsertPlan({ todos })
  }

  private upsertPlan(patch: { plan?: string; name?: string; overview?: string; todos?: unknown[] }): Item[] {
    const callId = this.planCallId ?? 'codex-plan'
    this.planCallId = callId
    let item = this.tools.get(callId)
    const prev = item?.args && typeof item.args === 'object' ? item.args : {}
    const args = {
      ...prev,
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.overview ? { overview: patch.overview } : {}),
      ...(patch.plan ? { plan: patch.plan } : {}),
      ...(patch.todos ? { todos: patch.todos } : {})
    }
    if (!item) {
      item = {
        id: newId(),
        kind: 'tool',
        callId,
        tool: 'createPlan',
        args,
        status: 'success',
        startedAt: Date.now(),
        endedAt: Date.now()
      }
      this.tools.set(callId, item)
      this.items.push(item)
      return [item]
    }
    item.tool = 'createPlan'
    item.args = args
    item.status = 'success'
    item.endedAt = Date.now()
    return [item]
  }

  private onThinking(ev: any): Item[] {
    if (ev.subtype === 'delta') {
      if (!this.thinking) {
        this.assistant = undefined
        this.thinking = { id: newId(), kind: 'thinking', text: '', done: false, startedAt: ev.timestamp_ms ?? Date.now() }
        this.items.push(this.thinking)
      }
      this.thinking.text += ev.text ?? ''
      return [this.thinking]
    }
    if (ev.subtype === 'completed' && this.thinking) {
      const t = this.thinking
      t.done = true
      t.endedAt = ev.timestamp_ms ?? Date.now()
      this.thinking = undefined
      return [t]
    }
    return []
  }

  private onAssistant(ev: any): Item[] {
    const text = textOf(ev.message)
    if (!text) return []
    const isDelta = ev.timestamp_ms !== undefined
    if (!isDelta && this.sawDelta) return []
    const changed = this.thinking ? this.closeSegments() : []
    if (isDelta) this.sawDelta = true
    let item = this.assistant
    if (!item) {
      item = { id: newId(), kind: 'assistant', text: '' }
      this.items.push(item)
    }
    item.text += text
    this.lastAssistantText = item.text
    this.assistant = isDelta ? item : undefined
    return [...changed, item]
  }

  private onTool(ev: any): Item[] {
    const callId: string = ev.call_id ?? ev.tool_call?.toolCallId ?? newId()
    const tc = ev.tool_call ?? {}
    const key = Object.keys(tc).find((k) => !TOOL_META_KEYS.has(k)) ?? 'unknownToolCall'
    const payload = tc[key] ?? {}
    const tool = key.replace(/ToolCall$/, '')

    if (ev.subtype === 'started') {
      const changed = this.closeSegments()
      const item: ToolItem = {
        id: newId(),
        kind: 'tool',
        callId,
        tool,
        args: compact(payload.args ?? {}),
        status: 'running',
        startedAt: Number(tc.startedAtMs) || Date.now()
      }
      this.tools.set(callId, item)
      this.items.push(item)
      return [...changed, item]
    }

    let item = this.tools.get(callId)
    if (!item) {
      item = { id: newId(), kind: 'tool', callId, tool, args: compact(payload.args ?? {}), status: 'running', startedAt: Date.now() }
      this.tools.set(callId, item)
      this.items.push(item)
    }
    if (payload.args) item.args = compact(payload.args)
    item.result = compact(payload.result)
    item.status = toolStatus(payload.result)
    item.endedAt = Number(tc.completedAtMs) || Date.now()
    return [item]
  }

  private onAcpTool(update: any): Item[] {
    const rawInput = update.rawInput
    if (isAskQuestionArgs(rawInput)) {
      const existing = this.tools.get(String(update.toolCallId || ''))
      if (!existing || existing.status !== 'running') return []
      existing.status = 'success'
      existing.endedAt = Date.now()
      return [existing]
    }
    const callId = String(update.toolCallId || newId())
    const args = argsFrom(update)
    const outputText = textOfContent(update.content)
    const result = attachContentDiffs(asToolResult(update.rawOutput, outputText), update.content)
    const status = acpToolStatus(update.status, result)

    if (update.sessionUpdate === 'tool_call' || !this.tools.has(callId)) {
      const changed = this.closeSegments()
      const item: ToolItem = {
        id: newId(),
        kind: 'tool',
        callId,
        tool: toolNameFrom(update, args),
        args: compact(args),
        status,
        startedAt: Date.now()
      }
      if (result !== undefined) item.result = compact(result)
      if (status !== 'running') item.endedAt = Date.now()
      this.tools.set(callId, item)
      this.items.push(item)
      return [...changed, item]
    }

    const item = this.tools.get(callId)!
    if (update.title && !item.tool) item.tool = toolNameFrom(update, args)
    if (rawInput && typeof rawInput === 'object') item.args = compact(args)
    if (result !== undefined) item.result = compact(result)
    item.status = status
    if (status !== 'running') item.endedAt = Date.now()
    return [item]
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const text = (content as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { text?: unknown; content?: { text?: unknown } }
    if (typeof b.content?.text === 'string') parts.push(b.content.text)
    else if (typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('')
}

function isAskQuestionArgs(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const questions = (raw as { questions?: unknown }).questions
  if (!Array.isArray(questions) || questions.length === 0) return false
  return questions.some((q) => q && typeof q === 'object' && ('prompt' in q || 'options' in q))
}

function argsFrom(update: any): Record<string, unknown> {
  const raw = update.rawInput && typeof update.rawInput === 'object' ? { ...update.rawInput } : {}
  const path = Array.isArray(update.locations) ? update.locations.find((l: any) => l?.path)?.path : undefined
  if (typeof path === 'string' && raw.path === undefined && raw.targetFile === undefined && raw.filePath === undefined && raw.command === undefined) {
    raw.path = path
  }
  return raw
}

function planHeading(markdown: string): { name?: string; overview?: string } {
  const heading = markdown.match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim()
  const overview = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('-') && !line.startsWith('*'))
  return { name: heading, overview: overview?.slice(0, 240) }
}

function toolNameFrom(update: any, args: Record<string, unknown>): string {
  if (typeof args.command === 'string') return 'shell'
  const rawName = String(args._toolName ?? args.name ?? update?.title ?? '')
  const compactName = rawName.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (typeof args.plan === 'string' || compactName === 'createplan' || compactName === 'updateplan') return 'createPlan'
  if (typeof args.globPattern === 'string' || typeof args.glob_pattern === 'string') return 'glob'
  const kind = String(update.kind ?? '')
  const mapped: Record<string, string> = {
    read: 'read',
    edit: 'edit',
    delete: 'delete',
    move: 'edit',
    search: 'grep',
    execute: 'shell',
    fetch: 'webFetch',
    think: 'thinking',
    switch_mode: 'switchMode'
  }
  if (mapped[kind]) return mapped[kind]
  return typeof update.title === 'string' && update.title ? update.title : 'tool'
}

function acpToolStatus(status: string | undefined, result: unknown): ToolItem['status'] {
  if (status === 'failed') return 'error'
  if (result && typeof result === 'object') {
    const r = result as { error?: unknown; failure?: unknown; success?: unknown }
    if ((r.error !== undefined || r.failure !== undefined) && r.success === undefined) return 'error'
  }
  if (status === 'completed') return 'success'
  return 'running'
}

interface DiffBlock {
  path: string
  oldText: string | null
  newText: string
}

/** ACP edit/delete calls carry `{ type: 'diff', oldText, newText }` instead of `diffString`. */
function diffBlocks(content: unknown): DiffBlock[] {
  if (!Array.isArray(content)) return []
  const out: DiffBlock[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: unknown; path?: unknown; oldText?: unknown; newText?: unknown }
    if (b.type !== 'diff' || typeof b.newText !== 'string') continue
    out.push({
      path: typeof b.path === 'string' ? b.path : '',
      oldText: typeof b.oldText === 'string' ? b.oldText : null,
      newText: b.newText
    })
  }
  return out
}

function attachContentDiffs(result: unknown, content: unknown): unknown {
  const blocks = diffBlocks(content)
  if (!blocks.length) return result
  const parts: string[] = []
  let added = 0
  let removed = 0
  let path: string | undefined
  for (const block of blocks) {
    const built = unifiedDiff(block.path || 'file', block.oldText, block.newText)
    if (!built.text) continue
    parts.push(built.text)
    added += built.added
    removed += built.removed
    if (!path && block.path) path = block.path
  }
  if (!parts.length) return result
  const extra: Record<string, unknown> = { diffString: parts.join('\n'), linesAdded: added, linesRemoved: removed }
  if (path) extra.path = path
  return mergeSuccess(result, extra)
}

function mergeSuccess(result: unknown, extra: Record<string, unknown>): unknown {
  if (result && typeof result === 'object') {
    const o = result as Record<string, unknown>
    if (o.success && typeof o.success === 'object') {
      const success = o.success as Record<string, unknown>
      if (typeof success.diffString === 'string' && success.diffString) return result
      return { ...o, success: { ...success, ...extra } }
    }
    if ('error' in o || 'failure' in o || 'rejected' in o) return result
    return { success: { ...o, ...extra } }
  }
  return { success: extra }
}

function asToolResult(raw: unknown, contentText: string): unknown {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if ('success' in o || 'error' in o || 'failure' in o || 'rejected' in o) return o
    if ('stdout' in o || 'stderr' in o || 'diffString' in o || 'exitCode' in o || 'linesAdded' in o) return { success: o }
    return o
  }
  if (typeof raw === 'string' && raw.trim()) return { success: { stdout: raw } }
  if (contentText.trim()) return { success: { stdout: contentText } }
  return undefined
}
