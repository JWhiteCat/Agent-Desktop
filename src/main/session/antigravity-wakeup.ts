import { textOfContent } from '../reducer'
import type { TurnTiming } from '../turn-timing'

const FOLLOWUP_LLM_MS = 300_000
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

interface TrackedTool {
  startedAt: number
  permissionWaitMs: number
  permissionSince?: number
  name: string
  kind: string
  waitMsBeforeAsync?: number
  isDaemon: boolean
  isSchedule: boolean
  isWorkflow: boolean
  isCommand: boolean
}

export interface AntigravityWakeupState {
  cascadeState: 'active' | 'yielding' | 'idle'
  deferredWakeup: 'none' | 'in_flight_reply' | 'awaiting_wakeup'
  suppressedReplyActive: boolean
  suppressedMessageId?: string
  yieldTimer?: NodeJS.Timeout
  tools: Map<string, TrackedTool>
  completedToolIds: Set<string>
}

export interface FollowupState {
  phase: 'llm' | 'suppressed_reply' | 'reply' | 'usage'
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
  antigravityWakeup?: AntigravityWakeupState
  timing?: TurnTiming
}

export function isAntigravityWakeupUpdate(update: any): boolean {
  return WAKEUP_UPDATES.has(update?.sessionUpdate)
}

export function hasPendingAntigravityWakeup(run: FollowupTarget): boolean {
  const state = run.antigravityWakeup
  return !!state && state.deferredWakeup !== 'none'
}

function ensureWakeupState(run: FollowupTarget): AntigravityWakeupState {
  if (!run.antigravityWakeup) {
    run.antigravityWakeup = {
      cascadeState: 'active',
      deferredWakeup: 'none',
      suppressedReplyActive: false,
      tools: new Map(),
      completedToolIds: new Set()
    }
  }
  return run.antigravityWakeup
}

function clearYieldTimer(state: AntigravityWakeupState): void {
  if (!state.yieldTimer) return
  clearTimeout(state.yieldTimer)
  state.yieldTimer = undefined
}

function inputRecord(update: any): Record<string, unknown> | undefined {
  if (update?.rawInput && typeof update.rawInput === 'object') return update.rawInput as Record<string, unknown>
  if (update?.args && typeof update.args === 'object') return update.args as Record<string, unknown>
  return undefined
}

function mergeTrackedTool(prev: TrackedTool | undefined, update: any, now: number): TrackedTool {
  const input = inputRecord(update)
  const name = typeof update?.name === 'string' && update.name ? update.name : prev?.name ?? ''
  const kind = typeof update?.kind === 'string' && update.kind ? update.kind : prev?.kind ?? ''
  const wait = typeof input?.WaitMsBeforeAsync === 'number' && Number.isFinite(input.WaitMsBeforeAsync)
    ? input.WaitMsBeforeAsync
    : prev?.waitMsBeforeAsync
  const isDaemon = prev?.isDaemon || input?.IsDaemon === true || input?.isDaemon === true
  const isSchedule = prev?.isSchedule
    || name === 'schedule'
    || input?.DurationSeconds !== undefined
    || input?.CronExpression !== undefined
  const isWorkflow = prev?.isWorkflow
    || name === 'run_workflow'
    || typeof input?.Script === 'string'
    || typeof input?.ScriptPath === 'string'
  const isCommand = prev?.isCommand
    || name === 'run_command'
    || kind === 'execute'
    || typeof input?.CommandLine === 'string'
  return {
    startedAt: prev?.startedAt ?? now,
    permissionWaitMs: prev?.permissionWaitMs ?? 0,
    permissionSince: prev?.permissionSince,
    name,
    kind,
    waitMsBeforeAsync: wait,
    isDaemon,
    isSchedule,
    isWorkflow,
    isCommand
  }
}

function toolOutputText(update: any): string {
  const raw = update?.rawOutput
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object') {
    if (typeof raw.output === 'string') return raw.output
    if (typeof raw.stdout === 'string') return raw.stdout
    if (typeof raw.formatted_output === 'string') return raw.formatted_output
  }
  return textOfContent(update?.content)
}

function hasSyncTimestamps(text: string): boolean {
  return /^Created At:/m.test(text) && /^Completed At:/m.test(text)
}

function wasBackgroundedToolCompletion(tool: TrackedTool, update: any, now: number): boolean {
  if (tool.isDaemon) return false
  if (tool.isSchedule) return true
  const text = toolOutputText(update)
  const extraPause = tool.permissionSince !== undefined ? Math.max(0, now - tool.permissionSince) : 0
  const elapsedMs = Math.max(0, now - tool.startedAt - tool.permissionWaitMs - extraPause)
  if (tool.isWorkflow) {
    if (hasSyncTimestamps(text)) return false
    if (tool.waitMsBeforeAsync === undefined || tool.waitMsBeforeAsync <= 0) return true
    return elapsedMs >= tool.waitMsBeforeAsync
  }
  if (tool.isCommand) {
    if (hasSyncTimestamps(text)) return false
    if (/^Command exited with code\b/.test(text.trimStart())) return true
    if (tool.waitMsBeforeAsync !== undefined && tool.waitMsBeforeAsync > 0) {
      return elapsedMs >= tool.waitMsBeforeAsync
    }
    return false
  }
  return false
}

/**
 * Antigravity resolves `session/prompt` before backgrounded commands, timers, or
 * subagents finish, then streams reactive wakeup steps on the same ACP session.
 */
export function waitForFollowup(run: FollowupTarget, opts?: { cascadeIdle?: boolean }): Promise<void> {
  const state = ensureWakeupState(run)
  if (opts?.cascadeIdle) {
    clearYieldTimer(state)
    state.cascadeState = 'idle'
    state.deferredWakeup = 'none'
    state.suppressedReplyActive = false
    state.suppressedMessageId = undefined
  }
  return new Promise((resolve) => {
    const followup: FollowupState = {
      phase: 'llm',
      finish: () => {
        if (run.followup !== followup) return
        if (followup.timer) clearTimeout(followup.timer)
        clearYieldTimer(state)
        run.followup = undefined
        resolve()
      }
    }
    run.followup = followup
    scheduleFollowupTimer(run)
  })
}

export function finishFollowup(run: FollowupTarget): void {
  if (run.antigravityWakeup) clearYieldTimer(run.antigravityWakeup)
  run.followup?.finish()
}

export function holdFollowupForInteraction(run: FollowupTarget, toolCallId?: string): void {
  const state = run.antigravityWakeup
  if (state) {
    clearYieldTimer(state)
    const now = Date.now()
    if (toolCallId && state.tools.has(toolCallId)) {
      const tool = state.tools.get(toolCallId)!
      if (tool.permissionSince === undefined) tool.permissionSince = now
    } else {
      for (const tool of state.tools.values()) {
        if (tool.permissionSince === undefined) tool.permissionSince = now
      }
    }
  }
  const followup = run.followup
  if (!followup?.timer) return
  clearTimeout(followup.timer)
  followup.timer = undefined
}

export function resumeFollowupAfterInteraction(run: FollowupTarget, toolCallId?: string): void {
  const state = run.antigravityWakeup
  if (state) {
    const now = Date.now()
    if (toolCallId && state.tools.has(toolCallId)) {
      const tool = state.tools.get(toolCallId)!
      if (tool.permissionSince !== undefined) {
        tool.permissionWaitMs += Math.max(0, now - tool.permissionSince)
        tool.permissionSince = undefined
      }
    } else {
      for (const tool of state.tools.values()) {
        if (tool.permissionSince !== undefined) {
          tool.permissionWaitMs += Math.max(0, now - tool.permissionSince)
          tool.permissionSince = undefined
        }
      }
    }
  }
  const followup = run.followup
  if (!followup) return
  followup.phase = 'llm'
  scheduleFollowupTimer(run)
}

export function observeAntigravityUpdate(run: FollowupTarget, update: any): void {
  const state = ensureWakeupState(run)
  const followup = run.followup
  const now = Date.now()
  switch (update?.sessionUpdate) {
    case 'tool_call':
    case 'tool_call_update': {
      const status = update?.status
      const callId = typeof update?.toolCallId === 'string' ? update.toolCallId : ''
      const isTerminal = status === 'completed' || status === 'failed'
      if (isTerminal) {
        if (callId && state.completedToolIds.has(callId)) break
        if (callId) state.completedToolIds.add(callId)
        const tracked = callId ? state.tools.get(callId) : undefined
        if (callId) state.tools.delete(callId)
        const tool = mergeTrackedTool(tracked, update, now)
        clearYieldTimer(state)
        if (wasBackgroundedToolCompletion(tool, update, now)) {
          if (state.cascadeState === 'idle') {
            state.cascadeState = 'active'
            state.deferredWakeup = 'none'
            state.suppressedReplyActive = false
            state.suppressedMessageId = undefined
            if (followup) followup.phase = 'llm'
          } else {
            const wasYielding = state.cascadeState === 'yielding'
            state.cascadeState = 'active'
            state.deferredWakeup = 'in_flight_reply'
            if (wasYielding) {
              state.suppressedReplyActive = true
              if (followup && !run.reducer.hasRunningForegroundTools()) followup.phase = 'suppressed_reply'
            } else if (followup) {
              followup.phase = 'llm'
            }
          }
        } else {
          state.cascadeState = 'active'
          state.deferredWakeup = 'none'
          state.suppressedReplyActive = false
          state.suppressedMessageId = undefined
          if (followup) followup.phase = 'llm'
        }
        break
      }

      const isNewTool = callId
        ? !state.tools.has(callId) && !state.completedToolIds.has(callId)
        : update?.sessionUpdate === 'tool_call'
      if (callId) state.tools.set(callId, mergeTrackedTool(state.tools.get(callId), update, now))
      clearYieldTimer(state)
      state.cascadeState = 'active'
      if (isNewTool) {
        state.deferredWakeup = 'none'
        state.suppressedReplyActive = false
        state.suppressedMessageId = undefined
      }
      if (followup) followup.phase = 'llm'
      break
    }
    case 'agent_thought_chunk':
      clearYieldTimer(state)
      state.cascadeState = 'active'
      if (state.deferredWakeup === 'awaiting_wakeup'
        || (state.deferredWakeup === 'in_flight_reply' && state.suppressedReplyActive)) {
        state.deferredWakeup = 'none'
        state.suppressedReplyActive = false
        state.suppressedMessageId = undefined
      }
      if (followup) followup.phase = 'llm'
      break
    case 'plan':
    case 'plan_update':
      if (!run.reducer.hasRunningForegroundTools()) {
        clearYieldTimer(state)
        state.cascadeState = 'active'
        if (state.deferredWakeup === 'awaiting_wakeup') state.deferredWakeup = 'none'
      }
      if (followup) followup.phase = 'llm'
      break
    case 'agent_message_chunk': {
      const messageId = typeof update?.messageId === 'string' && update.messageId.trim() ? update.messageId : undefined
      if (run.reducer.hasRunningForegroundTools()) {
        if (state.deferredWakeup === 'awaiting_wakeup') state.deferredWakeup = 'none'
        if (state.deferredWakeup === 'in_flight_reply') {
          state.suppressedReplyActive = true
          if (messageId) state.suppressedMessageId = messageId
        } else {
          state.cascadeState = 'yielding'
          if (messageId) state.suppressedMessageId = messageId
          scheduleYieldTimer(run, state)
        }
        break
      }
      clearYieldTimer(state)
      if (state.deferredWakeup === 'awaiting_wakeup') {
        state.deferredWakeup = 'none'
        state.suppressedReplyActive = false
        state.suppressedMessageId = undefined
      } else if (state.deferredWakeup === 'in_flight_reply') {
        if (state.suppressedReplyActive && messageId && state.suppressedMessageId && messageId !== state.suppressedMessageId) {
          state.deferredWakeup = 'none'
          state.suppressedReplyActive = false
          state.suppressedMessageId = undefined
        } else {
          state.suppressedReplyActive = true
          if (messageId) state.suppressedMessageId = messageId
          if (followup) followup.phase = 'suppressed_reply'
          break
        }
      }
      if (followup) followup.phase = 'reply'
      break
    }
    case 'usage_update':
      clearYieldTimer(state)
      if (state.deferredWakeup === 'in_flight_reply') {
        state.deferredWakeup = 'awaiting_wakeup'
        state.suppressedReplyActive = false
        state.suppressedMessageId = undefined
        state.cascadeState = 'active'
        if (followup) followup.phase = 'llm'
        break
      }
      if (run.reducer.hasRunningForegroundTools()) {
        if (state.cascadeState === 'yielding') {
          state.cascadeState = 'idle'
          state.suppressedMessageId = undefined
        }
        if (followup) followup.phase = 'llm'
        break
      }
      if (followup) {
        followup.phase = followup.phase === 'reply' ? 'usage' : 'llm'
      }
      break
    default:
      return
  }
  scheduleFollowupTimer(run)
}

function scheduleYieldTimer(run: FollowupTarget, state: AntigravityWakeupState): void {
  clearYieldTimer(state)
  if (run.stopped || run.settled || run.proc.dying || run.proc.child.exitCode !== null || run.pendingQuestions?.size) return
  state.yieldTimer = setTimeout(() => {
    state.yieldTimer = undefined
    if (run.stopped || run.settled || run.proc.dying || run.proc.child.exitCode !== null) return
    if (state.cascadeState === 'yielding' && run.reducer.hasRunningForegroundTools()) {
      state.cascadeState = 'idle'
      state.suppressedMessageId = undefined
    }
  }, FOLLOWUP_REPLY_MS)
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
  if (followup.phase === 'suppressed_reply') {
    followup.timer = setTimeout(() => {
      if (run.followup !== followup) return
      followup.timer = undefined
      const state = run.antigravityWakeup
      if (state && state.deferredWakeup === 'in_flight_reply') {
        state.deferredWakeup = 'awaiting_wakeup'
        state.suppressedReplyActive = false
        state.suppressedMessageId = undefined
        state.cascadeState = 'active'
      }
      followup.phase = 'llm'
      scheduleFollowupTimer(run)
    }, FOLLOWUP_REPLY_MS)
    return
  }
  const ms = followup.phase === 'llm' ? FOLLOWUP_LLM_MS : followup.phase === 'reply' ? FOLLOWUP_REPLY_MS : FOLLOWUP_USAGE_MS
  followup.timer = setTimeout(() => followup.finish(), ms)
}
