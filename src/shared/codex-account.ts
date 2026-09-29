/** Codex's estimated cumulative charge for one thread, independent of other threads. */
export interface CodexThreadUsage {
  threadId: string
  credits: number
  costUsd?: number
}

/** account/usage/read uses integer millionths; missing usage is never a zero charge. */
export function parseCodexThreadUsage(body: unknown, expectedThreadId: string): CodexThreadUsage | undefined {
  const root = record(body)
  const usage = record(root?.threadUsage)
  if (!expectedThreadId || usage?.threadId !== expectedThreadId) return undefined
  const credits = micros(usage.estimatedUsageCreditsMicros)
  if (credits === undefined) return undefined
  const costUsd = micros(usage.estimatedUsageUsdMicros)
  return { threadId: expectedThreadId, credits, ...(costUsd === undefined ? {} : { costUsd }) }
}

function micros(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value / 1_000_000 : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
