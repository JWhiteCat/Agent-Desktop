import type { TokenUsage } from '@shared/model-prices'
import { parseCodexQuota } from '@shared/quota'
import { quotaSnapshot, type TurnQuotaSnapshot } from '@shared/turn-quota'

export interface CodexUsageTurn {
  usageId: string
  turnId?: string
  startedAt?: number
  createdAt?: number
  model?: string
  usage: TokenUsage
  quotaSnapshot?: TurnQuotaSnapshot
  isError: boolean
  completed: boolean
  /** Original zero-based JSONL line, including blank or malformed lines. */
  endLine: number
}

interface Counters {
  input: number
  output: number
  cached: number
  written: number
}

interface WorkingTurn extends CodexUsageTurn {
  userSources: Set<string>
  explicitStart: boolean
}

const zeroCounters = (): Counters => ({ input: 0, output: 0, cached: 0, written: 0 })

/** Codex totals accumulate across model requests and user turns, including cached input. */
export function parseCodexUsage(text: string): CodexUsageTurn[] {
  const turns: CodexUsageTurn[] = []
  let sessionId = 'unknown'
  let inheritedUsage = false
  let previous: Counters | undefined
  let previousLast: Counters | undefined
  let active: WorkingTurn | undefined
  let model: string | undefined
  let lastLine = -1

  function finish(endLine: number): void {
    if (!active) return
    active.endLine = Math.max(active.endLine, endLine)
    if (active.usage.requests?.length) {
      const { userSources: _, explicitStart: __, ...turn } = active
      turns.push(turn)
    }
    active = undefined
  }

  function begin(line: number, timestamp?: number, turnId?: string): WorkingTurn {
    finish(line - 1)
    active = {
      usageId: turnId ? `codex:${turnId}` : `codex:${sessionId}:line:${line}`,
      turnId,
      startedAt: timestamp,
      model,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: [] },
      isError: false,
      completed: false,
      endLine: line,
      userSources: new Set(),
      explicitStart: false
    }
    return active
  }

  function identify(turnId: string | undefined): void {
    if (!active || !turnId) return
    active.turnId = turnId
    active.usageId = `codex:${turnId}`
  }

  for (const [line, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue
    let row: any
    try {
      row = JSON.parse(raw)
    } catch {
      continue // A live rollout may end in a partially written JSON object.
    }
    lastLine = line
    const payload = row?.payload ?? row
    const type = String(payload?.type ?? '')
    const timestamp = timeOf(row?.timestamp)
    const turnId = nonempty(payload?.turn_id)

    if (row?.type === 'session_meta') {
      sessionId = nonempty(payload?.id) ?? nonempty(payload?.session_id) ?? sessionId
      inheritedUsage = Boolean(payload?.forked_from_id)
      continue
    }

    if (row?.type === 'event_msg' && type === 'task_started') {
      const sameTurn = turnId !== undefined && active?.turnId === turnId
      if (!sameTurn && (!active || active.completed || active.explicitStart || active.turnId)) {
        begin(line, timeOf(payload.started_at) ?? timestamp, turnId)
      }
      identify(turnId)
      if (!active!.explicitStart) active!.startedAt = timeOf(payload.started_at) ?? timestamp ?? active!.startedAt
      active!.explicitStart = true
      continue
    }

    if (row?.type === 'turn_context') {
      model = nonempty(payload?.model) ?? model
      if (!active || (turnId && active.turnId && turnId !== active.turnId)) begin(line, timestamp, turnId)
      identify(turnId)
      active!.model = model
      continue
    }

    const userSource = row?.type === 'event_msg' && type === 'user_message'
      ? 'event'
      : row?.type === 'response_item' && type === 'message' && payload.role === 'user' ? 'response' : undefined
    if (userSource) {
      // Modern rollouts record the same prompt as both an event and a response item.
      // A task_started boundary also allows steering messages inside the same turn.
      if (!active || active.completed || (!active.explicitStart && (active.userSources.has(userSource) || active.usage.requests!.length > 0))) {
        if (active && !active.explicitStart) active.completed = true
        begin(line, timestamp, turnId)
      }
      active!.userSources.add(userSource)
      active!.startedAt ??= timestamp
      identify(turnId)
      continue
    }

    if (row?.type !== 'event_msg') continue
    if (type === 'task_complete' || type === 'turn_aborted') {
      if (active && (!turnId || !active.turnId || turnId === active.turnId)) {
        identify(turnId)
        active.completed = true
        active.isError = type === 'turn_aborted'
        active.createdAt = timeOf(payload.completed_at) ?? timestamp ?? active.createdAt
        active.endLine = line
      }
      continue
    }
    if (type !== 'token_count') continue
    // Quota-only updates and repeated token counters can carry a fresher account snapshot.
    const snapshot = quotaSnapshot(parseCodexQuota(payload?.rate_limits ?? payload?.rateLimits), timestamp ?? active?.createdAt ?? active?.startedAt ?? NaN)
    if (snapshot && active) {
      active.quotaSnapshot = snapshot
      active.endLine = line
    }
    const current = counters(payload?.info?.total_token_usage)
    const last = counters(payload?.info?.last_token_usage)
    if (!current) continue // Quota-only events carry no usage information.
    let increment: Counters
    if (!previous) {
      // Forked files can inherit a cumulative total without copying its earlier events.
      increment = inheritedUsage ? last ?? zeroCounters() : current
    } else if (same(current, previous)) {
      continue // Rate limit updates repeat the most recent token count.
    } else if (decreased(current, previous)) {
      // Compaction/resume may reset the total. Do not add an unchanged last request twice.
      increment = last && (!previousLast || !same(last, previousLast)) ? last : zeroCounters()
    } else {
      increment = subtract(current, previous)
    }
    previous = current
    previousLast = last
    if (!increment.input && !increment.output) continue
    if (!active) begin(line, timestamp, turnId)
    if (snapshot) active!.quotaSnapshot = snapshot
    const request = requestUsage(increment)
    active!.usage.requests!.push(request)
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
      active!.usage[key] = (active!.usage[key] ?? 0) + (request[key] ?? 0)
    }
    if (!active!.completed) active!.createdAt = timestamp ?? active!.createdAt
    active!.endLine = line
  }
  finish(lastLine)
  return turns
}

function counters(value: any): Counters | undefined {
  if (!value || !Number.isFinite(value.input_tokens) || !Number.isFinite(value.output_tokens)) return undefined
  return {
    input: nonnegative(value.input_tokens),
    output: nonnegative(value.output_tokens),
    cached: nonnegative(value.cached_input_tokens),
    written: nonnegative(value.cache_write_input_tokens)
  }
}

function requestUsage(value: Counters): Omit<TokenUsage, 'requests'> {
  const cacheReadTokens = Math.min(value.input, value.cached)
  const cacheWriteTokens = Math.min(value.input - cacheReadTokens, value.written)
  return {
    inputTokens: value.input - cacheReadTokens - cacheWriteTokens,
    outputTokens: value.output, // reasoning_output_tokens is already included here.
    cacheReadTokens,
    cacheWriteTokens
  }
}

function same(a: Counters, b: Counters): boolean {
  return a.input === b.input && a.output === b.output && a.cached === b.cached && a.written === b.written
}

function decreased(a: Counters, b: Counters): boolean {
  return a.input < b.input || a.output < b.output || a.cached < b.cached || a.written < b.written
}

function subtract(a: Counters, b: Counters): Counters {
  return { input: a.input - b.input, output: a.output - b.output, cached: a.cached - b.cached, written: a.written - b.written }
}

function nonnegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined
}

function timeOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value < 1e12 ? value * 1000 : value)
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}
