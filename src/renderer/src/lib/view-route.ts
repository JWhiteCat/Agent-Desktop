import type { View } from '../store/state'
import { REMOTE_VIEW_KEY } from '../store/persistence'

type RoutedApp = { threads: { id: string }[]; projects: { id: string }[] }

/** Hash fragment for the open page, without the leading `#`. */
export function viewHash(view: View): string {
  if (view.kind === 'thread') return `thread=${encodeURIComponent(view.id)}`
  if (view.kind === 'grokbot') return view.botId ? `grokbot=${encodeURIComponent(view.botId)}` : 'grokbot'
  if (view.projectId) return `project=${encodeURIComponent(view.projectId)}`
  return ''
}

/** The page named by a remote URL hash. An unknown id does not fall through to another kind. */
export function viewFromHash(hash: string, app: RoutedApp): View | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  const params = new URLSearchParams(raw)
  const threadId = params.get('thread')
  if (threadId) return app.threads.some((thread) => thread.id === threadId) ? { kind: 'thread', id: threadId } : null
  if (params.has('grokbot')) {
    const botId = params.get('grokbot') || undefined
    return botId ? { kind: 'grokbot', botId } : { kind: 'grokbot' }
  }
  const projectId = params.get('project')
  if (projectId) return app.projects.some((project) => project.id === projectId) ? { kind: 'home', projectId } : null
  return null
}

/**
 * A hash in the address bar wins. Otherwise reopen whatever this browser last showed.
 * A hash that names a missing conversation stays unresolved so refresh does not jump elsewhere.
 */
export function restoreRemoteView(hash: string, stored: string | null, app: RoutedApp): View | null {
  if ((hash.startsWith('#') ? hash.slice(1) : hash).length) return viewFromHash(hash, app)
  return stored ? viewFromHash(stored, app) : null
}

let syncRemoteView = false

/** Later page changes on the remote client update the address bar and this browser. */
export function enableRemoteViewSync(): void {
  syncRemoteView = true
}

function sameView(a: View, b: View): boolean {
  if (a.kind === 'thread' && b.kind === 'thread') return a.id === b.id
  if (a.kind === 'grokbot' && b.kind === 'grokbot') return a.botId === b.botId
  if (a.kind === 'home' && b.kind === 'home') return a.projectId === b.projectId
  return false
}

/** Keep the remote URL and this browser pointed at the page the user is looking at. */
export function publishRemoteView(view: View): void {
  const next = viewHash(view)
  try {
    localStorage.setItem(REMOTE_VIEW_KEY, next)
  } catch {
    /* Storage can be unavailable. The address bar still survives a refresh. */
  }
  try {
    const current = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash
    if (current === next) return
    history.replaceState(null, '', `${location.pathname}${location.search}${next ? `#${next}` : ''}`)
  } catch {
    /* The in-memory page still works for this visit. */
  }
}

export function syncRemoteViewIfEnabled(prev: View, next: View): void {
  if (!syncRemoteView || sameView(prev, next)) return
  publishRemoteView(next)
}
