import type { TokenUsage } from './model-prices'

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
  const input = includesCache ? Math.max(inputTokens - cacheReadTokens - cacheWriteTokens, 0) : inputTokens
  if (input + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) return undefined
  return { inputTokens: input, outputTokens, cacheReadTokens, cacheWriteTokens }
}

function pick(u: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(u, key)) continue
    const value = u[key]
    if (value == null || value === '') continue
    const n = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return 0
}
