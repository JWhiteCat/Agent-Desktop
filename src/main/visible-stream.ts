import { Tiktoken } from 'js-tiktoken/lite'
import cl100k from 'js-tiktoken/ranks/cl100k_base'
import type { ResultItem } from '@shared/types'
import { textOfContent } from './reducer'

export type VisibleStream = NonNullable<NonNullable<ResultItem['timing']>['visibleStream']>
const MIN_WINDOW_MS = 100
const MAX_TEXT_LENGTH = 200_000
const MAX_BPE_WORK = 1_000_000
let tokenizer: Tiktoken | undefined

/** BPE merging can be quadratic for long unbroken strings. Bound optional metric work. */
function tokenizationWork(text: string): number {
  let work = 0
  for (const match of text.matchAll(new RegExp(cl100k.pat_str, 'ug'))) {
    const bytes = Buffer.byteLength(match[0])
    if (bytes > 512) return Infinity
    work += bytes * bytes
    if (work > MAX_BPE_WORK) return Infinity
  }
  return work
}

/** Fixed, local BPE reference — not a claim about the provider's private/model tokenizer. */
export function estimateVisibleTokens(text: string): number {
  if (!Number.isFinite(tokenizationWork(text))) throw new Error('Text exceeds streaming metric tokenizer budget')
  tokenizer ??= new Tiktoken(cl100k)
  // Treat special-token-looking user/model text as ordinary text, not control tokens.
  return tokenizer.encode(text, [], []).length
}

interface Segment {
  messageId?: string
  firstAt: number
  lastAt: number
  firstBatchLastChar: string
  tail: string
  dropped: boolean
}

/** Tracks contiguous top-level visible text, never provider total/reasoning usage. */
export class VisibleStreamRecorder {
  private active?: Segment
  private segments: Segment[] = []
  private storedLength = 0
  private finished = false

  observe(update: any, at: number): void {
    if (this.finished || !Number.isFinite(at)) return
    // Subagent output must not be merged into the main reply's numerator or interval.
    if (update?._meta?.claudeCode?.parentToolUseId) {
      this.boundary()
      return
    }
    if (update?.sessionUpdate !== 'agent_message_chunk') {
      if (['agent_thought_chunk', 'tool_call', 'tool_call_update', 'user_message_chunk', 'plan', 'plan_update', 'compaction_update', 'notice'].includes(update?.sessionUpdate)) this.boundary()
      return
    }
    const text = textOfContent(update.content)
    if (!text) return
    const messageId = typeof update.messageId === 'string' && update.messageId.trim() ? update.messageId : undefined
    if (this.active && (this.active.messageId !== messageId || at < this.active.lastAt)) this.boundary()
    if (!this.active) {
      if (!text.trim()) return
      this.active = { messageId, firstAt: at, lastAt: at, firstBatchLastChar: text.slice(-1), tail: '', dropped: false }
      return
    }
    const segment = this.active
    segment.lastAt = at
    if (at === segment.firstAt) {
      // Several JSON lines in one stdout delivery are ONE batch, not measurable token streaming.
      segment.firstBatchLastChar = text.slice(-1)
      return
    }
    if (segment.dropped) return
    this.storedLength += text.length
    if (this.storedLength > MAX_TEXT_LENGTH) {
      segment.dropped = true
      segment.tail = ''
      return
    }
    segment.tail += text
  }

  boundary(): void {
    if (this.active) this.segments.push(this.active)
    this.active = undefined
  }

  discard(): void {
    this.finished = true
    this.active = undefined
    this.segments = []
  }

  finish(countTokens: (text: string) => number = estimateVisibleTokens): VisibleStream | undefined {
    if (this.finished) return undefined
    this.finished = true
    this.boundary()
    let tokens = 0
    let durationMs = 0
    let segments = 0
    let excludedSegments = 0
    let work = 0
    for (const segment of this.segments) {
      const elapsed = segment.lastAt - segment.firstAt
      if (segment.dropped || elapsed < MIN_WINDOW_MS || !segment.tail.trim()) { excludedSegments++; continue }
      // Tokenize the concatenated post-first-batch suffix ONCE, not each chunk or a
      // cumulative-count subtraction (BPE can merge tokens across chunk boundaries).
      let tail = segment.tail
      if (/^[\uDC00-\uDFFF]/.test(tail) && /[\uD800-\uDBFF]$/.test(segment.firstBatchLastChar)) tail = segment.firstBatchLastChar + tail
      // An oversized segment is skipped without using up the budget of later, cheap segments.
      const cost = tokenizationWork(tail)
      if (work + cost > MAX_BPE_WORK) { excludedSegments++; continue }
      work += cost
      let count: number
      try { count = countTokens(tail) } catch { excludedSegments++; continue }
      if (!Number.isSafeInteger(count) || count <= 0) { excludedSegments++; continue }
      tokens += count
      durationMs += elapsed
      segments++
    }
    this.segments = []
    return segments ? { tokenizer: 'cl100k_base', tokens, durationMs, segments, excludedSegments } : undefined
  }
}
