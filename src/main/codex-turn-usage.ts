import { readCodexUsage } from './codex-history'
import type { CodexUsageTurn } from './codex-usage'

/** The adapter reports only its last model request. Rollouts retain the whole turn. */
export class CodexTurnUsageReader {
  private readonly previous: Set<string>
  private readonly startedAt = Date.now()
  private selectedId?: string
  private finishedAt?: number

  constructor(private readonly sessionId: string) {
    this.previous = new Set((readCodexUsage(sessionId) ?? []).map((turn) => turn.usageId))
  }

  read(): CodexUsageTurn | undefined {
    const turns = readCodexUsage(this.sessionId) ?? []
    if (this.selectedId) return turns.find((turn) => turn.usageId === this.selectedId)
    const candidates = turns.filter((turn) =>
      !this.previous.has(turn.usageId)
      && turn.startedAt != null
      && turn.startedAt >= this.startedAt - 1000
      && (this.finishedAt == null || turn.startedAt <= this.finishedAt)
    )
    // A different client can resume the same session. Do not guess between turns.
    if (candidates.length !== 1) return undefined
    this.selectedId = candidates[0].usageId
    return candidates[0]
  }

  async finish(): Promise<CodexUsageTurn | undefined> {
    this.finishedAt = Date.now()
    let turn = this.read()
    // The JSONL writer can finish a little after the ACP response arrives.
    for (let attempt = 0; attempt < 20 && !turn?.completed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      turn = this.read()
    }
    return turn
  }
}
