import type { ResultItem } from './types'

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
