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

/** The current view doubles as our position when a previous read or load failed. */
export function getNextUnreadThread(state: Pick<AppState, 'threads' | 'running'>, currentId?: string): ThreadMeta | undefined {
  const unread = getUnreadThreads(state)
  const current = unread.findIndex((thread) => thread.id === currentId)
  return unread[current < 0 ? 0 : (current + 1) % unread.length]
}

/** Global conversation counts, independent of sidebar visibility or archive filters. */
export function getTaskCounts(state: Pick<AppState, 'threads' | 'running'>): TaskCounts {
  const threadIds = new Set(state.threads.map((thread) => thread.id))
  const runningIds = new Set(state.running.filter((id) => threadIds.has(id)))
  return { running: runningIds.size, unread: getUnreadThreads(state).length }
}
