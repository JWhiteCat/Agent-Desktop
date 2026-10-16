import type { AppState, ThreadMeta } from './types'

export interface TaskCounts {
  running: number
  unread: number
}

/** The unread navigation and count share one global definition, including archives. */
export function getUnreadThreads(state: Pick<AppState, 'threads' | 'running'>): ThreadMeta[] {
  const runningIds = new Set(state.running)
  const seen = new Set<string>()
  return state.threads.filter((thread) => {
    if (thread.unread !== true || runningIds.has(thread.id) || seen.has(thread.id)) return false
    seen.add(thread.id)
    return true
  }).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The running navigation and count include the same existing conversations, including archives. */
export function getRunningThreads(state: Pick<AppState, 'threads' | 'running'>): ThreadMeta[] {
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

export function getNextUnreadThread(state: Pick<AppState, 'threads' | 'running'>, currentId?: string): ThreadMeta | undefined {
  return getNextThread(getUnreadThreads(state), currentId)
}

export function getNextRunningThread(state: Pick<AppState, 'threads' | 'running'>, currentId?: string): ThreadMeta | undefined {
  return getNextThread(getRunningThreads(state), currentId)
}

/** Global conversation counts, independent of sidebar visibility or archive filters. */
export function getTaskCounts(state: Pick<AppState, 'threads' | 'running'>): TaskCounts {
  return { running: getRunningThreads(state).length, unread: getUnreadThreads(state).length }
}
