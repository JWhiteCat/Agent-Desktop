import type { AppState } from './types'

export interface TaskCounts {
  running: number
  unread: number
}

/** Global conversation counts, independent of sidebar visibility or archive filters. */
export function getTaskCounts(state: Pick<AppState, 'threads' | 'running'>): TaskCounts {
  const threadIds = new Set(state.threads.map((thread) => thread.id))
  const runningIds = new Set(state.running.filter((id) => threadIds.has(id)))
  const unreadIds = new Set(state.threads
    .filter((thread) => thread.unread === true && !runningIds.has(thread.id))
    .map((thread) => thread.id))
  return { running: runningIds.size, unread: unreadIds.size }
}
