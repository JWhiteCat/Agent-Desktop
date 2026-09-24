import type { AssistantItem, Item, ThinkingItem, ToolItem } from '@shared/types'
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
function compact(value: unknown, depth = 0): unknown {
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
  private sawDelta = false
  init: InitInfo = {}
  gotResult = false
  lastAssistantText = ''

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
}
