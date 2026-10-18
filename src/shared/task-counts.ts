import type { AppState, ThreadMeta } from './types'

export interface TaskCounts {
  running: number
  unread: number
}

type TaskState = Pick<AppState, 'threads' | 'running' | 'waitingForInput'>

/** Waiting questions can be read before their run ends. */
export function isThreadUnread(thread: ThreadMeta, state: Pick<TaskState, 'running' | 'waitingForInput'>): boolean {
  return thread.unread === true && (!state.running.includes(thread.id) || !!state.waitingForInput?.includes(thread.id))
}

/** The unread navigation and count share one global definition, including archives. */
export function getUnreadThreads(state: TaskState): ThreadMeta[] {
  const seen = new Set<string>()
  return state.threads.filter((thread) => {
    if (!isThreadUnread(thread, state) || seen.has(thread.id)) return false
    seen.add(thread.id)
    return true
  }).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The running navigation and count include the same existing conversations, including archives. */
export function getRunningThreads(state: TaskState): ThreadMeta[] {
  const runningIds = new Set(state.running)
  const seen = new Set<string>()
  return state.threads.filter((thread) => {
    if (!runningIds.has(thread.id) || seen.has(thread.id)) return false
    seen.add(thread.id)
    return true
  }).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The current view doubles as our position when a previous read or load failed. */
function getNextThread(threads: ThreadMeta[], currentId?: string): ThreadMeta | undefined {
  const current = threads.findIndex((thread) => thread.id === currentId)
  return threads[current < 0 ? 0 : (current + 1) % threads.length]
}

export function getNextUnreadThread(state: TaskState, currentId?: string): ThreadMeta | undefined {
  return getNextThread(getUnreadThreads(state), currentId)
}

export function getNextRunningThread(state: TaskState, currentId?: string): ThreadMeta | undefined {
  return getNextThread(getRunningThreads(state), currentId)
}

/** Global conversation counts, independent of sidebar visibility or archive filters. */
export function getTaskCounts(state: TaskState): TaskCounts {
  return { running: getRunningThreads(state).length, unread: getUnreadThreads(state).length }
}
