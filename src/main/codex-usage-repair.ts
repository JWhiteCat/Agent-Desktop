import type { Item, ResultItem } from '@shared/types'
import type { CodexUsageTurn } from './codex-usage'

const COMPLETION_TOLERANCE_MS = 5_000

interface SavedTurn {
  result: ResultItem
  userAt?: number
  nextUserAt?: number
}

/** Repair existing result records only when their Codex turn can be identified. */
export function repairCodexUsage(items: Item[], turns: CodexUsageTurn[]): boolean {
  const saved = savedTurns(items)
  const completed = turns.filter((turn) => turn.completed)
  const matches = new Map<SavedTurn, CodexUsageTurn>()
  const reservedIds = new Set<string>()

  // Stable IDs also identify copied results whose surrounding messages changed.
  for (const entry of saved) {
    if (!entry.result.usageId) continue
    const exact = completed.filter((turn) => turn.usageId === entry.result.usageId)
    if (exact.length !== 1) continue
    matches.set(entry, exact[0])
    reservedIds.add(exact[0].usageId)
  }

  const candidates = new Map<SavedTurn, CodexUsageTurn[]>()
  const claims = new Map<CodexUsageTurn, number>()
  for (const entry of saved) {
    if (matches.has(entry)) continue
    const possible = completed.filter((turn) => !reservedIds.has(turn.usageId) && matchesTime(entry, turn))
    candidates.set(entry, possible)
    for (const turn of possible) claims.set(turn, (claims.get(turn) ?? 0) + 1)
  }
  for (const [entry, possible] of candidates) {
    if (possible.length === 1 && claims.get(possible[0]) === 1) matches.set(entry, possible[0])
  }

  let changed = false
  for (const [entry, turn] of matches) {
    const result = entry.result
    if (turn.quotaSnapshot && !result.quotaSnapshot) {
      result.quotaSnapshot = structuredClone(turn.quotaSnapshot)
      changed = true
    }
    if (JSON.stringify(result.usage) !== JSON.stringify(turn.usage)) {
      result.usage = structuredClone(turn.usage)
      changed = true
    }
    if (result.usageId !== turn.usageId) {
      result.usageId = turn.usageId
      changed = true
    }
    if (result.cli !== 'codex') {
      result.cli = 'codex'
      changed = true
    }
    if (result.usageComplete !== true) {
      result.usageComplete = true
      changed = true
    }
    if (!result.model && turn.model) {
      result.model = turn.model
      changed = true
    }
  }
  return changed
}

function savedTurns(items: Item[]): SavedTurn[] {
  const saved: SavedTurn[] = []
  let userAt: number | undefined
  let pending: SavedTurn[] = []
  for (const item of items) {
    if (item.kind === 'user') {
      for (const entry of pending) entry.nextUserAt = item.createdAt
      pending = []
      userAt = item.createdAt
    } else if (item.kind === 'result' && (!item.cli || item.cli === 'codex')) {
      const entry: SavedTurn = { result: item, userAt }
      saved.push(entry)
      pending.push(entry)
    }
  }
  return saved
}

function matchesTime(entry: SavedTurn, turn: CodexUsageTurn): boolean {
  const finishedAt = entry.result.createdAt
  const { userAt, nextUserAt } = entry
  if (!validTime(userAt) || !validTime(finishedAt) || finishedAt < userAt) return false
  if (!validTime(turn.startedAt) || !validTime(turn.createdAt)) return false
  if (turn.startedAt < userAt || turn.createdAt < turn.startedAt) return false
  if (Math.abs(turn.createdAt - finishedAt) > COMPLETION_TOLERANCE_MS) return false
  if (validTime(nextUserAt) && (turn.startedAt >= nextUserAt || turn.createdAt > nextUserAt)) return false
  return true
}

function validTime(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}
