import type { AssistantItem, Item } from './types'

const CURSOR_TERMINALS_RE = /(?:^|[\s"'\\/])\.cursor[\\/]projects[\\/][^"'\\\r\n]+[\\/]terminals[\\/]/i
const CURSOR_AGENT_TOOLS_RE = /(?:^|[\s"'\\/])\.cursor[\\/]projects[\\/][^"'\\\r\n]+[\\/]agent-tools[\\/]/i
const RETRIABLE_STREAM_ERROR_RE = /^\s*Error:\s*RetriableError\b/
const TOOL_PATH_KEYS = ['path', 'Path', 'filePath', 'targetFile', 'command', 'CommandLine'] as const
const SUBSTANTIAL_ASSISTANT_MIN_LENGTH = 200

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

function toolArgsMatch(item: Item, pattern: RegExp): boolean {
  if (item.kind !== 'tool' || !item.args || typeof item.args !== 'object') return false
  const args = item.args as Record<string, unknown>
  for (const key of TOOL_PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && pattern.test(value)) return true
  }
  return false
}

/** Cursor CLI saves background shell output under `.cursor/projects/<ws>/terminals/`. */
export function isCursorTerminalTool(item: Item): boolean {
  return toolArgsMatch(item, CURSOR_TERMINALS_RE)
}

/** Cursor CLI spills oversized tool output under `.cursor/projects/<ws>/agent-tools/`. */
export function isCursorAgentToolsTool(item: Item): boolean {
  return toolArgsMatch(item, CURSOR_AGENT_TOOLS_RE)
}

/** Tool items that only report or inspect background task completion rather than starting new foreground work. */
export function isBackgroundFollowupTool(item: Item): boolean {
  return isBackgroundAgentItem(item) || isCursorTerminalTool(item)
}

function isRetriableStreamErrorText(text: string): boolean {
  return RETRIABLE_STREAM_ERROR_RE.test(text)
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
      if (previous?.kind === 'assistant' && assistantIndex !== undefined && assistantIndex < merged.length - 1
        && previous.messageId === item.messageId) {
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

/**
 * Picks which assistant messages in a completed turn stay visible outside the
 * collapsed process steps bar:
 * 1. The final assistant message is always visible.
 * 2. Any trailing assistant messages after the last foreground tool call stay
 *    visible (covers Cursor background-task follow-ups separated only by
 *    thinking or terminal-log reads, and Codex explanations before questions).
 * 3. A substantial earlier reply (>= 200 chars and longer than the final
 *    follow-up) immediately followed by inspecting Cursor background artifacts
 *    (`terminals/` or `agent-tools/`) also stays visible even if the follow-up
 *    subsequently ran a quick verification tool.
 * 4. If an earlier in-turn `result` boundary exists (e.g. Antigravity reactive
 *    wakeup), the visible assistant output before that boundary stays visible.
 */
export function visibleAssistantIndices(
  steps: readonly Item[],
  resultBoundaries?: readonly number[]
): number[] {
  let lastIdx = -1
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === 'assistant') {
      lastIdx = i
      break
    }
  }
  if (lastIdx < 0) return []

  const kept = new Set<number>([lastIdx])

  let lastFgTool = -1
  for (let i = lastIdx - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.kind === 'tool' && step.tool !== 'createPlan' && !isBackgroundFollowupTool(step)) {
      lastFgTool = i
      break
    }
  }
  for (let i = lastFgTool + 1; i < lastIdx; i++) {
    const step = steps[i]
    if (step.kind === 'assistant' && !isRetriableStreamErrorText(step.text)) {
      kept.add(i)
    }
  }

  const lastLen = (steps[lastIdx] as AssistantItem).text.trim().length
  for (let i = 0; i < lastFgTool; i++) {
    const step = steps[i]
    if (step.kind !== 'assistant' || kept.has(i) || isRetriableStreamErrorText(step.text)) continue
    const len = step.text.trim().length
    if (len < SUBSTANTIAL_ASSISTANT_MIN_LENGTH || len <= lastLen) continue
    for (let j = i + 1; j < steps.length; j++) {
      const next = steps[j]
      if (next.kind === 'assistant') break
      if (next.kind === 'tool' && next.tool !== 'createPlan') {
        if (isCursorTerminalTool(next) || isCursorAgentToolsTool(next)) kept.add(i)
        break
      }
    }
  }

  if (resultBoundaries?.length) {
    for (const boundary of resultBoundaries) {
      if (boundary <= 0 || boundary >= steps.length) continue
      for (const idx of visibleAssistantIndices(steps.slice(0, boundary))) {
        const step = steps[idx]
        if (step.kind === 'assistant' && !isRetriableStreamErrorText(step.text)) {
          kept.add(idx)
        }
      }
    }
  }

  return [...kept].sort((a, b) => a - b)
}

export function visibleAssistantText(
  steps: readonly Item[],
  resultBoundaries?: readonly number[]
): string | undefined {
  const indices = visibleAssistantIndices(steps, resultBoundaries)
  if (!indices.length) return undefined
  const texts = indices.map((i) => (steps[i] as AssistantItem).text)
  if (texts.length === 1) return texts[0]
  const nonEmpty = texts.filter((text) => text.trim().length > 0)
  return (nonEmpty.length ? nonEmpty : texts).join('\n\n')
}

function pickPreviewText(steps: readonly Item[], resultBoundaries?: readonly number[]): string | undefined {
  const indices = visibleAssistantIndices(steps, resultBoundaries)
  if (!indices.length) return undefined
  const lastText = (steps[indices[indices.length - 1]] as AssistantItem).text
  const lastLen = lastText.trim().length
  for (let k = indices.length - 2; k >= 0; k--) {
    const candidate = (steps[indices[k]] as AssistantItem).text
    const len = candidate.trim().length
    if (len >= SUBSTANTIAL_ASSISTANT_MIN_LENGTH && len > lastLen) return candidate
  }
  return lastText
}

export function latestTurnPreview(
  items: readonly Item[],
  opts?: { currentTurnOnly?: boolean }
): string {
  const turns: Array<{ steps: Item[]; resultBoundaries: number[] }> = []
  let current: { steps: Item[]; resultBoundaries: number[] } | undefined
  for (const item of mergeInterruptedAssistantMessages(items)) {
    if (item.kind === 'user') {
      current = { steps: [], resultBoundaries: [] }
      turns.push(current)
      continue
    }
    if (!current) {
      current = { steps: [], resultBoundaries: [] }
      turns.push(current)
    }
    if (item.kind === 'result') {
      current.resultBoundaries.push(current.steps.length)
    } else {
      current.steps.push(item)
    }
  }
  const format = (text: string | undefined): string =>
    (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)

  if (opts?.currentTurnOnly) {
    const last = turns.at(-1)
    return last ? format(pickPreviewText(last.steps, last.resultBoundaries)) : ''
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const preview = format(pickPreviewText(turns[i].steps, turns[i].resultBoundaries))
    if (preview) return preview
  }
  return ''
}
