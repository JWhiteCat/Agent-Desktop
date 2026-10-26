import type { TokenUsage } from './model-prices'

/** A trailing all-zero placeholder must not erase positive counts already observed this turn. */
export function preferTurnUsage(latest: TokenUsage | undefined, previous: TokenUsage | undefined): TokenUsage | undefined {
  if (!latest) return previous
  const positive = (usage: TokenUsage | undefined) => usage &&
    [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].some((value) => value !== undefined && value > 0)
  return !positive(latest) && positive(previous) ? previous : latest
}

/**
 * Cursor's ACP `turnEnded` update counts cache tokens inside `inputTokens`.
 * The stream-json printer splits them back out; pricing needs the same split.
 * `inputIncludesCache` marks that raw shape. Other payloads are already split.
 */
export function normalizeTurnUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const outputTokens = pick(u, 'outputTokens', 'output_tokens')
  const cacheReadTokens = pick(u, 'cacheReadTokens', 'cachedReadTokens', 'cache_read_tokens', 'cached_read_tokens')
  const cacheWriteTokens = pick(u, 'cacheWriteTokens', 'cachedWriteTokens', 'cache_write_tokens', 'cached_write_tokens')
  const includesCache = u.inputIncludesCache === true || u.input_includes_cache === true
  const inputTokens = pick(u, 'inputTokens', 'input_tokens')
  // Cache-inclusive input cannot be split accurately if either cache component is absent.
  const input = includesCache
    ? inputTokens !== undefined && cacheReadTokens !== undefined && cacheWriteTokens !== undefined
      ? Math.max(inputTokens - cacheReadTokens - cacheWriteTokens, 0) : undefined
    : inputTokens
  if ([input, outputTokens, cacheReadTokens, cacheWriteTokens].every((value) => value === undefined)) return undefined
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {})
  }
}

function pick(u: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(u, key)) continue
    const value = u[key]
    if (value == null || (typeof value === 'string' && !value.trim()) || typeof value === 'boolean') continue
    const n = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return undefined
}
