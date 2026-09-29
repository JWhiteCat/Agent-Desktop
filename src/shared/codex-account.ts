/** Codex's estimated cumulative charge for one thread, independent of other threads. */
export interface CodexThreadUsage {
  threadId: string
  credits: number
  costUsd?: number
}

/** Consumer subscription allowance and balance debits attributed to one Codex thread. */
export interface CodexSessionUsage {
  threadId: string
  status: 'available' | 'partial' | 'unavailable'
  weekly?: number
  fiveHour?: number
  /** Preserve the backend decimal, including adjustments and values below JS precision. */
  balanceCredits?: string
  dataAsOf?: string
}

/** query_v2 reports session attribution directly; missing amounts are never zero usage. */
export function parseCodexSessionUsage(body: unknown, expectedThreadId: string): CodexSessionUsage | undefined {
  const root = record(body)
  if (!expectedThreadId.trim() || !Array.isArray(root?.threads)) return undefined
  const matches = root.threads.map(record).filter((thread) => thread?.thread_id === expectedThreadId)
  if (matches.length !== 1) return undefined
  const usage = matches[0]!
  const status = usage.data_status
  if (status !== 'available' && status !== 'partial' && status !== 'unavailable') return undefined
  const dataAsOf = isoTimestamp(root.data_as_of)
  const result: CodexSessionUsage = {
    threadId: expectedThreadId,
    status,
    ...(dataAsOf === undefined ? {} : { dataAsOf })
  }
  // An unavailable row can still contain stale fields; none describe a usable reading.
  if (status === 'unavailable') return result
  const weekly = percent(usage.weekly_limit_percent)
  const fiveHour = percent(usage.five_hour_limit_percent)
  const balanceCredits = decimal(usage.balance_usage_credits)
  if (weekly !== undefined) result.weekly = weekly
  if (fiveHour !== undefined) result.fiveHour = fiveHour
  if (balanceCredits !== undefined) result.balanceCredits = balanceCredits
  if (weekly === undefined && fiveHour === undefined && balanceCredits === undefined) result.status = 'unavailable'
  return result
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

function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function decimal(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 128
    && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ? value : undefined
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) return undefined
  const year = Number(match[1])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return Number(match[3]) <= days[Number(match[2]) - 1] ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
