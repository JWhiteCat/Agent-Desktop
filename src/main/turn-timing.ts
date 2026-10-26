import { performance } from 'node:perf_hooks'
import type { ResultItem } from '@shared/types'
import { textOfContent } from './reducer'
import { VisibleStreamRecorder } from './visible-stream'

/** One ACP prompt, including all model requests, tools, retries and user waits inside it. */
export class TurnTiming {
  private readonly started: number
  private firstVisibleOutputMs?: number
  private result?: NonNullable<ResultItem['timing']>
  private stream = new VisibleStreamRecorder()

  constructor(private readonly now: () => number = () => performance.now()) {
    this.started = now()
  }

  observe(update: any, at = this.now()): void {
    if (this.result) return
    this.stream.observe(update, at)
    if (this.firstVisibleOutputMs !== undefined || update?.sessionUpdate !== 'agent_message_chunk' || update?._meta?.claudeCode?.parentToolUseId) return
    // This is time to visible reply text, not time to hidden reasoning or a tool call.
    // Use exactly the same extraction as the rendered transcript (including older adapters).
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
      ...(this.firstVisibleOutputMs !== undefined ? { firstVisibleOutputMs: this.firstVisibleOutputMs } : {}),
      ...(outcome === 'completed' && visibleStream ? { visibleStream } : {}),
      outcome
    }
  }
}
