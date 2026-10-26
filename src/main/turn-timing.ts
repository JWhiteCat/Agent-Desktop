import { performance } from 'node:perf_hooks'
import type { ResultItem } from '@shared/types'
import { textOfContent } from './reducer'

/** One ACP prompt, including all model requests, tools, retries and user waits inside it. */
export class TurnTiming {
  private readonly started: number
  private firstVisibleOutputMs?: number
  private result?: NonNullable<ResultItem['timing']>

  constructor(private readonly now: () => number = () => performance.now()) {
    this.started = now()
  }

  observe(update: any): void {
    if (this.result || this.firstVisibleOutputMs !== undefined || update?.sessionUpdate !== 'agent_message_chunk') return
    // This is time to visible reply text, not time to hidden reasoning or a tool call.
    // Use exactly the same extraction as the rendered transcript (including older adapters).
    if (textOfContent(update.content).trim()) {
      this.firstVisibleOutputMs = Math.max(0, this.now() - this.started)
    }
  }

  finish(outcome: NonNullable<ResultItem['timing']>['outcome']): NonNullable<ResultItem['timing']> {
    return this.result ??= {
      elapsedMs: Math.max(0, this.now() - this.started),
      ...(this.firstVisibleOutputMs !== undefined ? { firstVisibleOutputMs: this.firstVisibleOutputMs } : {}),
      outcome
    }
  }
}
