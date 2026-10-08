import type { GrokBotMessage, GrokBotTurn } from './types'

/** Later updates of the same entry replace it; the list stays in transcript order. */
export function mergeGrokBotMessages(current: GrokBotMessage[], incoming: GrokBotMessage[]): GrokBotMessage[] {
  if (!incoming.length) return current
  const bySeq = new Map(current.map((m) => [m.seq, m]))
  for (const m of incoming) {
    const old = bySeq.get(m.seq)
    if (!old || Number(m.updatedSeq) >= Number(old.updatedSeq)) bySeq.set(m.seq, m)
  }
  return [...bySeq.values()].sort((a, b) => Number(a.seq) - Number(b.seq))
}

export function grokBotBusy(turn: GrokBotTurn | undefined): boolean {
  return !!turn && (turn.inFlight || turn.queued > 0)
}
