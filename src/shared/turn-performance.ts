import type { ResultItem } from './types'

/** Whole-turn effective throughput, never decoder speed. Require a measured, completed interval. */
export function effectiveOutputTps(item: ResultItem): number | undefined {
  const timing = item.timing
  const output = item.usage?.outputTokens
  if (!timing || timing.outcome !== 'completed' || item.isError || item.usageComplete === false
    || !Number.isFinite(timing.elapsedMs) || timing.elapsedMs <= 0
    || output === undefined || !Number.isFinite(output) || output < 0) return undefined
  const rate = output / (timing.elapsedMs / 1000)
  return Number.isFinite(rate) ? rate : undefined
}
