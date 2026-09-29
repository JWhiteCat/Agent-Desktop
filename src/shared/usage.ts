import { quoteModel, type TokenUsage } from './model-prices'
import { threadCli, type CliProvider, type Item } from './types'

export type UsageWindow = '1d' | '7d' | '30d'

const WINDOWS: Record<UsageWindow, number> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
}

export interface UsageModelRow {
  cli: CliProvider
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

export interface UsageSessionModel {
  id: string
  label: string
}

export interface UsageSessionRow {
  threadId: string
  cli: CliProvider
  title: string
  project?: string
  /** Models used on counted turns, or the session model when none were recorded. */
  models: UsageSessionModel[]
  /** Time of the latest counted turn, or the session's last update. */
  at: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Sum of priced turns. Null when every counted turn is unpriced, or the session has no usage. */
  costUsd: number | null
}

export interface UsageReport {
  summary: UsageSummary
  sessions: UsageSessionRow[]
}

export interface UsageThread {
  id?: string
  cli?: CliProvider
  title?: string
  project?: string
  model?: string
  updatedAt?: number
  items: Item[]
}

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function tokensOf(usage: TokenUsage): [number, number, number, number] {
  return [num(usage.inputTokens), num(usage.outputTokens), num(usage.cacheReadTokens), num(usage.cacheWriteTokens)]
}

interface Turn {
  key: string
  cli: CliProvider
  at: number
  model: string
  usage: TokenUsage
}

/** Turns recorded on one session. A copied fork turn stays on that session. */
function turnsOf(thread: UsageThread): Turn[] {
  const seen = new Set<string>()
  const turns: Turn[] = []
  let lastUserAt: number | undefined
  for (const item of thread.items) {
    if (item.kind === 'user') {
      lastUserAt = item.createdAt
      continue
    }
    if (item.kind !== 'result' || !item.usage) continue
    const at = item.createdAt ?? lastUserAt
    if (at == null) continue
    const cli = item.cli ?? threadCli(thread)
    const model = item.model || thread.model || ''
    const [input, output, cacheRead, cacheWrite] = tokensOf(item.usage)
    const key = item.usageId ? `usage|${item.usageId}` : `${cli}|${at}|${model}|${input}|${output}|${cacheRead}|${cacheWrite}`
    if (seen.has(key)) continue
    seen.add(key)
    turns.push({ key, cli, at, model, usage: item.usage })
  }
  return turns
}

function collectTurns(threads: UsageThread[]): Turn[] {
  const seen = new Set<string>()
  const turns: Turn[] = []
  for (const thread of threads) {
    for (const turn of turnsOf(thread)) {
      if (seen.has(turn.key)) continue
      seen.add(turn.key)
      turns.push(turn)
    }
  }
  return turns
}

function sessionModels(turns: { model: string; cli: CliProvider }[]): UsageSessionModel[] {
  const models: UsageSessionModel[] = []
  const seen = new Set<string>()
  for (const turn of turns) {
    const model = turn.model.trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    models.push({ id: model, label: quoteModel(model, {}, turn.cli).label })
  }
  return models
}

/** Lifetime totals for every saved session. Not filtered by the summary window. */
export function listSessionUsage(threads: UsageThread[]): UsageSessionRow[] {
  const rows: UsageSessionRow[] = []
  for (const thread of threads) {
    if (!thread.id) continue
    const cli = threadCli(thread)
    const turns = turnsOf(thread)
    const row: UsageSessionRow = {
      threadId: thread.id,
      cli,
      title: thread.title?.trim() || '未命名',
      project: thread.project?.trim() || undefined,
      models: [],
      at: thread.updatedAt ?? 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null
    }
    let priced = 0
    let unpriced = 0
    for (const turn of turns) {
      const quote = quoteModel(turn.model, turn.usage, turn.cli)
      const [input, output, cacheRead, cacheWrite] = tokensOf(turn.usage)
      row.turns += 1
      row.inputTokens += input
      row.outputTokens += output
      row.cacheReadTokens += cacheRead
      row.cacheWriteTokens += cacheWrite
      if (turn.at > row.at) row.at = turn.at
      if (quote.costUsd == null) unpriced += 1
      else priced += quote.costUsd
    }
    row.models = sessionModels(turns.length ? turns : [{ model: thread.model ?? '', cli }])
    row.costUsd = !turns.length || unpriced === row.turns ? null : priced
    rows.push(row)
  }
  rows.sort((a, b) => b.at - a.at)
  return rows
}

/** Rolls up local turns. Forks that share a `usageId` (or the same user time and tokens) count once. */
export function summarizeUsage(threads: UsageThread[], period: UsageWindow, now = Date.now()): UsageSummary {
  const span = WINDOWS[period]
  if (!span) throw new Error('未知的统计范围')
  const from = now - span
  const rows = new Map<string, UsageModelRow>()

  for (const turn of collectTurns(threads)) {
    if (turn.at < from || turn.at > now) continue
    const quote = quoteModel(turn.model, turn.usage, turn.cli)
    const group = `${turn.cli}\n${turn.model}\n${quote.label}`
    let row = rows.get(group)
    if (!row) {
      row = {
        cli: turn.cli,
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
