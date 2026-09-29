import { quotaDelta, type TurnQuotaUsage } from '@shared/turn-quota'
import { loadCodexQuotaSnapshot, type CodexQuotaSnapshot } from './quota'

type SnapshotLoader = (apiKey?: string) => Promise<CodexQuotaSnapshot | undefined>

/** Stays in the main process; only the resulting usage is sent to the renderer. */
export interface CodexQuotaTurn {
  before: Promise<CodexQuotaSnapshot | undefined>
}

interface TrackedTurn {
  load: () => Promise<CodexQuotaSnapshot | undefined>
  overlapping: boolean
  startedAt?: number
  result?: Promise<TurnQuotaUsage | undefined>
}

/** Measures account-quota changes only for turns that do not overlap another local Codex turn. */
export class CodexTurnQuotaTracker {
  private readonly active = new Map<CodexQuotaTurn, TrackedTurn>()

  constructor(private readonly loadSnapshot: SnapshotLoader = loadCodexQuotaSnapshot) {}

  start(apiKey?: string): CodexQuotaTurn {
    const load = async () => {
      try {
        return await this.loadSnapshot(apiKey)
      } catch {
        return undefined
      }
    }
    const state: TrackedTurn = { load, overlapping: this.active.size > 0 }
    for (const turn of this.active.values()) turn.overlapping = true
    const handle: CodexQuotaTurn = { before: load() }
    this.active.set(handle, state)
    return handle
  }

  /** Call after awaiting handle.before and immediately before sending the prompt. */
  markPromptStarted(handle: CodexQuotaTurn): void {
    const state = this.active.get(handle)
    if (state && state.startedAt == null && !state.result) state.startedAt = Date.now()
  }

  /** Releases a handle when preparation failed before any prompt was submitted. */
  cancel(handle: CodexQuotaTurn): void {
    this.active.delete(handle)
  }

  finish(handle: CodexQuotaTurn): Promise<TurnQuotaUsage | undefined> {
    const state = this.active.get(handle)
    if (!state) return Promise.resolve(undefined)
    if (state.result) return state.result
    const finishedAt = Date.now()
    state.result = this.measure(handle, state, finishedAt).finally(() => this.active.delete(handle))
    return state.result
  }

  private async measure(handle: CodexQuotaTurn, state: TrackedTurn, finishedAt: number): Promise<TurnQuotaUsage | undefined> {
    const before = await handle.before
    const startedAt = state.startedAt
    if (!before || !this.active.has(handle) || startedAt == null || !Number.isFinite(before.sampledAt) || before.sampledAt > startedAt || finishedAt < startedAt) return undefined
    // Keep the turn active while sampling: a new turn can begin before this fetch completes.
    const after = await state.load()
    if (
      !after ||
      state.overlapping ||
      !this.active.has(handle) ||
      !before.accountKey ||
      before.accountKey !== after.accountKey ||
      !Number.isFinite(after.sampledAt) ||
      after.sampledAt < finishedAt
    ) return undefined
    return quotaDelta(before.quota, after.quota, before.sampledAt, after.sampledAt)
  }
}
