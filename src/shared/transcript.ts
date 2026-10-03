import type { Item } from './types'

/** Codex emits this background notification independently of the active reply. */
export function isBackgroundAgentActivity(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false
  const activity = args as { agentThreadId?: unknown; activityKind?: unknown }
  return typeof activity.agentThreadId === 'string' && activity.agentThreadId.trim().length > 0
    && activity.activityKind === 'completed'
}

export function isBackgroundAgentItem(item: Item): boolean {
  return item.kind === 'tool' && isBackgroundAgentActivity(item.args)
}

/**
 * Older reducers split a streaming reply when a background agent completed.
 * Rejoin only those fragments for display, leaving persisted items untouched.
 * Keep the final fragment's id so forking includes the entire original reply.
 */
export function mergeInterruptedAssistantMessages(items: readonly Item[]): Item[] {
  const merged: Item[] = []
  let assistantIndex: number | undefined
  for (const item of items) {
    if (item.kind === 'assistant') {
      const previous = assistantIndex === undefined ? undefined : merged[assistantIndex]
      if (previous?.kind === 'assistant' && assistantIndex !== undefined && assistantIndex < merged.length - 1) {
        merged.splice(assistantIndex, 1)
        merged.push({ ...item, text: previous.text + item.text })
      } else {
        merged.push(item)
      }
      assistantIndex = merged.length - 1
    } else {
      merged.push(item)
      if (!isBackgroundAgentItem(item)) assistantIndex = undefined
    }
  }
  return merged
}
