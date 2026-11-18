import { isBackgroundAgentItem } from './transcript'
import type { Item, ResultItem, UserItem } from './types'

function validDuration(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function isCompactionToolItem(item: Item): boolean {
  return item.kind === 'tool' && item.tool === 'thinking'
    && (!item.args || typeof item.args !== 'object' || Object.keys(item.args as Record<string, unknown>).length === 0)
}

function firstMainAgentStep(steps: readonly Item[]): Item | undefined {
  return steps.find((step) =>
    step.kind === 'thinking'
    || step.kind === 'assistant'
    || (step.kind === 'tool' && !isBackgroundAgentItem(step) && !isCompactionToolItem(step))
  )
}

/**
 * Client-observed latency from prompt dispatch to first main-agent output.
 * Reconstructs older persisted turns only when synchronous completion timestamps bound the step.
 */
export function firstTokenLatencyMs(item: ResultItem, steps?: readonly Item[], user?: UserItem): number | undefined {
  const timing = item.timing
  if (!timing || !validDuration(timing.elapsedMs)) return undefined
  if (timing.firstTokenMs !== undefined) {
    return validDuration(timing.firstTokenMs) && timing.firstTokenMs <= timing.elapsedMs
      ? timing.firstTokenMs : undefined
  }
  if (!steps) return undefined
  const firstStep = firstMainAgentStep(steps)
  if (!firstStep) return undefined
  if (firstStep.kind === 'assistant') {
    return validDuration(timing.firstVisibleOutputMs) && timing.firstVisibleOutputMs <= timing.elapsedMs
      ? timing.firstVisibleOutputMs : undefined
  }
  if ((firstStep.kind !== 'thinking' && firstStep.kind !== 'tool')
    || timing.outcome !== 'completed'
    || !validDuration(firstStep.startedAt)
    || !validDuration(item.createdAt)) {
    return undefined
  }
  const turnStartedAt = item.createdAt - timing.elapsedMs
  if (user && validDuration(user.createdAt) && turnStartedAt < user.createdAt - 1000) return undefined
  const rawDelta = firstStep.startedAt - turnStartedAt
  if (!Number.isFinite(rawDelta) || rawDelta < -50) return undefined
  const reconstructed = Math.max(0, rawDelta)
  if (reconstructed > timing.elapsedMs) return undefined
  if (timing.firstVisibleOutputMs !== undefined && Number.isFinite(timing.firstVisibleOutputMs)
    && reconstructed > timing.firstVisibleOutputMs + 100) {
    return undefined
  }
  return reconstructed
}

/** Backfills `firstTokenMs` on legacy timed results whose turn steps prove the initial response time. */
export function repairTurnTimings(items: readonly Item[]): boolean {
  let changed = false
  let user: UserItem | undefined
  let steps: Item[] = []
  for (const item of items) {
    if (item.kind === 'user') {
      user = item
      steps = []
      continue
    }
    if (item.kind !== 'result') {
      steps.push(item)
      continue
    }
    if (item.timing && item.timing.firstTokenMs === undefined) {
      const recovered = firstTokenLatencyMs(item, steps, user)
      if (recovered !== undefined) {
        item.timing.firstTokenMs = recovered
        changed = true
      }
    }
    steps = []
  }
  return changed
}

/** Tokenizer-estimated visible streaming throughput, never whole-turn or backend decoder speed. */
export function visibleOutputTps(item: ResultItem): number | undefined {
  const timing = item.timing
  const stream = timing?.visibleStream
  if (!timing || timing.outcome !== 'completed' || item.isError || !stream
    || !Number.isFinite(timing.elapsedMs) || stream.durationMs > timing.elapsedMs
    || stream.tokenizer !== 'cl100k_base' || !Number.isFinite(stream.durationMs) || stream.durationMs < 100
    || !Number.isSafeInteger(stream.tokens) || stream.tokens <= 0
    || !Number.isSafeInteger(stream.segments) || stream.segments <= 0 || stream.durationMs < stream.segments * 100
    || !Number.isSafeInteger(stream.excludedSegments) || stream.excludedSegments < 0) return undefined
  const rate = stream.tokens / (stream.durationMs / 1000)
  return Number.isFinite(rate) ? rate : undefined
}
