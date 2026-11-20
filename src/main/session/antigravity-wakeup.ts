import type { TurnTiming } from '../turn-timing'

const FOLLOWUP_LLM_MS = 120_000
const FOLLOWUP_REPLY_MS = 2000
const FOLLOWUP_USAGE_MS = 250

const WAKEUP_UPDATES = new Set([
  'agent_thought_chunk',
  'agent_message_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update'
])

export interface FollowupState {
  phase: 'llm' | 'reply' | 'usage'
  timer?: NodeJS.Timeout
  finish: () => void
}

/** Minimal turn shape observed by Antigravity reactive wakeup / followup tracking. */
export interface FollowupTarget {
  stopped: boolean
  settled: boolean
  proc: { dying: boolean; child: { exitCode: number | null } }
  reducer: { hasRunningForegroundTools: () => boolean }
  pendingQuestions?: Map<string, unknown>
  followup?: FollowupState
  timing?: TurnTiming
}

export function isAntigravityWakeupUpdate(update: any): boolean {
  return WAKEUP_UPDATES.has(update?.sessionUpdate)
}

/**
 * Antigravity resolves `session/prompt` before backgrounded commands, timers, or
 * subagents finish, then streams reactive wakeup steps on the same ACP session.
 */
export function waitForFollowup(run: FollowupTarget): Promise<void> {
  return new Promise((resolve) => {
    const followup: FollowupState = {
      phase: 'llm',
      finish: () => {
        if (run.followup !== followup) return
        if (followup.timer) clearTimeout(followup.timer)
        run.followup = undefined
        resolve()
      }
    }
    run.followup = followup
    scheduleFollowupTimer(run)
  })
}

export function finishFollowup(run: FollowupTarget): void {
  run.followup?.finish()
}

export function holdFollowupForInteraction(run: FollowupTarget): void {
  const followup = run.followup
  if (!followup?.timer) return
  clearTimeout(followup.timer)
  followup.timer = undefined
}

export function resumeFollowupAfterInteraction(run: FollowupTarget): void {
  const followup = run.followup
  if (!followup) return
  followup.phase = 'llm'
  scheduleFollowupTimer(run)
}

export function observeFollowup(run: FollowupTarget, update: any): void {
  const followup = run.followup
  if (!followup) return
  switch (update?.sessionUpdate) {
    case 'tool_call':
    case 'tool_call_update':
    case 'agent_thought_chunk':
    case 'plan':
    case 'plan_update':
      followup.phase = 'llm'
      break
    case 'agent_message_chunk':
      if (!run.reducer.hasRunningForegroundTools()) followup.phase = 'reply'
      break
    case 'usage_update':
      if (!run.reducer.hasRunningForegroundTools()) {
        followup.phase = followup.phase === 'reply' ? 'usage' : 'llm'
      }
      break
    default:
      return
  }
  scheduleFollowupTimer(run)
}

function scheduleFollowupTimer(run: FollowupTarget): void {
  const followup = run.followup
  if (!followup) return
  if (followup.timer) {
    clearTimeout(followup.timer)
    followup.timer = undefined
  }
  if (run.stopped || run.settled || run.proc.dying || run.proc.child.exitCode !== null) {
    followup.finish()
    return
  }
  if (run.pendingQuestions?.size || run.reducer.hasRunningForegroundTools()) return
  const ms = followup.phase === 'llm' ? FOLLOWUP_LLM_MS : followup.phase === 'reply' ? FOLLOWUP_REPLY_MS : FOLLOWUP_USAGE_MS
  followup.timer = setTimeout(() => followup.finish(), ms)
}
