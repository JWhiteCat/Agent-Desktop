import { performance } from 'node:perf_hooks'
import { isBackgroundAgentActivity } from '@shared/transcript'
import type { ResultItem } from '@shared/types'
import { textOfContent } from './reducer'
import { VisibleStreamRecorder } from './visible-stream'

function isMainAgentOutput(update: any): boolean {
  if (!update || typeof update !== 'object') return false
  if (update._meta?.claudeCode?.parentToolUseId) return false
  if (update._meta?.contextCompaction || update._meta?.claudeCode?.toolName === 'compact') return false
  switch (update.sessionUpdate) {
    case 'agent_thought_chunk':
    case 'agent_message_chunk':
      return Boolean(textOfContent(update.content).trim())
    case 'tool_call':
      return !isBackgroundAgentActivity(update.rawInput)
    case 'plan_update':
      return typeof update.plan?.content === 'string' && Boolean(update.plan.content.trim())
    case 'plan':
      return Array.isArray(update.entries) && update.entries.length > 0
    default:
      return false
  }
}

/** One ACP prompt, including all model requests, tools, retries and user waits inside it. */
export class TurnTiming {
  private readonly started: number
  private firstTokenMs?: number
  private firstVisibleOutputMs?: number
  private result?: NonNullable<ResultItem['timing']>
  private stream = new VisibleStreamRecorder()

  constructor(private readonly now: () => number = () => performance.now()) {
    this.started = now()
  }

  observe(update: any, at = this.now()): void {
    if (this.result) return
    this.stream.observe(update, at)
    if (this.firstTokenMs === undefined && isMainAgentOutput(update)) {
      this.firstTokenMs = Math.max(0, at - this.started)
    }
    if (this.firstVisibleOutputMs !== undefined || update?.sessionUpdate !== 'agent_message_chunk' || update?._meta?.claudeCode?.parentToolUseId) return
    // Separately retain when visible reply text began, distinct from initial thought/tool output.
    if (textOfContent(update.content).trim()) {
      this.firstVisibleOutputMs = Math.max(0, at - this.started)
    }
  }

  interrupt(): void { this.stream.boundary() }

  finish(outcome: NonNullable<ResultItem['timing']>['outcome']): NonNullable<ResultItem['timing']> {
    if (this.result) return this.result
    const elapsedMs = Math.max(0, this.now() - this.started)
    const visibleStream = outcome === 'completed' ? this.stream.finish() : undefined
    if (outcome !== 'completed') this.stream.discard()
    return this.result = {
      elapsedMs,
      ...(this.firstTokenMs !== undefined ? { firstTokenMs: this.firstTokenMs } : {}),
      ...(this.firstVisibleOutputMs !== undefined ? { firstVisibleOutputMs: this.firstVisibleOutputMs } : {}),
      ...(outcome === 'completed' && visibleStream ? { visibleStream } : {}),
      outcome
    }
  }
}
