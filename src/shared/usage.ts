import { quoteModel, type TokenUsage } from './model-prices'
import type { Item } from './types'

export type UsageWindow = '1d' | '7d' | '30d'

const WINDOWS: Record<UsageWindow, number> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
}

export interface UsageModelRow {
  model: string
  label: string
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Null when the model has no published price. */
  costUsd: number | null
}

export interface UsageSummary {
  from: number
  to: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Sum of priced turns. Null when every turn in the window is unpriced, or the window is empty. */
  costUsd: number | null
  unpricedTurns: number
  models: UsageModelRow[]
}

export interface UsageThread {
  model?: string
  items: Item[]
}

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function tokensOf(usage: TokenUsage): [number, number, number, number] {
  return [num(usage.inputTokens), num(usage.outputTokens), num(usage.cacheReadTokens), num(usage.cacheWriteTokens)]
}

interface Turn {
  at: number
  model: string
  usage: TokenUsage
}

function collectTurns(threads: UsageThread[]): Turn[] {
  const seen = new Set<string>()
  const turns: Turn[] = []
  for (const thread of threads) {
    let lastUserAt: number | undefined
    for (const item of thread.items) {
      if (item.kind === 'user') {
        lastUserAt = item.createdAt
        continue
      }
      if (item.kind !== 'result' || !item.usage) continue
      const at = item.createdAt ?? lastUserAt
      if (at == null) continue
      const model = item.model || thread.model || ''
      const [input, output, cacheRead, cacheWrite] = tokensOf(item.usage)
      const key = item.usageId || `${at}|${model}|${input}|${output}|${cacheRead}|${cacheWrite}`
      if (seen.has(key)) continue
      seen.add(key)
      turns.push({ at, model, usage: item.usage })
    }
  }
  return turns
}

/** Rolls up local turns. Forks that share a `usageId` (or the same user time and tokens) count once. */
export function summarizeUsage(threads: UsageThread[], period: UsageWindow, now = Date.now()): UsageSummary {
  const span = WINDOWS[period]
  if (!span) throw new Error('未知的统计范围')
  const from = now - span
  const rows = new Map<string, UsageModelRow>()

  for (const turn of collectTurns(threads)) {
    if (turn.at < from || turn.at > now) continue
    const quote = quoteModel(turn.model, turn.usage)
    const group = `${turn.model}\n${quote.label}`
    let row = rows.get(group)
    if (!row) {
      row = {
        model: turn.model,
        label: quote.label,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: quote.costUsd == null ? null : 0
      }
      rows.set(group, row)
    }
    const [input, output, cacheRead, cacheWrite] = tokensOf(turn.usage)
    row.turns += 1
    row.inputTokens += input
    row.outputTokens += output
    row.cacheReadTokens += cacheRead
    row.cacheWriteTokens += cacheWrite
    if (quote.costUsd != null && row.costUsd != null) row.costUsd += quote.costUsd
  }

  const models = [...rows.values()].sort((a, b) => {
    if ((a.costUsd == null) !== (b.costUsd == null)) return a.costUsd == null ? 1 : -1
    if (a.costUsd != null && b.costUsd != null && a.costUsd !== b.costUsd) return b.costUsd - a.costUsd
    const tokens = (row: UsageModelRow) => row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens
    return tokens(b) - tokens(a)
  })

  const summary: UsageSummary = {
    from,
    to: now,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    unpricedTurns: 0,
    models
  }
  for (const row of models) {
    summary.turns += row.turns
    summary.inputTokens += row.inputTokens
    summary.outputTokens += row.outputTokens
    summary.cacheReadTokens += row.cacheReadTokens
    summary.cacheWriteTokens += row.cacheWriteTokens
    if (row.costUsd == null) summary.unpricedTurns += row.turns
    else summary.costUsd = (summary.costUsd ?? 0) + row.costUsd
  }
  return summary
}
