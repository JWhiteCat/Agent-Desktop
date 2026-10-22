import { useMemo, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import type { AppState } from '@shared/types'

interface DraftCell<T> {
  read: () => T
  subscribe: (listener: () => void) => () => void
  set: Dispatch<SetStateAction<T>>
}

// Keep File objects and in-flight form state in this renderer only. Navigation
// unmounts the UI; async completions still belong to the original draft cell.
const scopes = new Map<string, Map<string, DraftCell<unknown>>>()

export const threadDraftScope = (id: string): string => `thread:${id}`
export const projectDraftScope = (id: string): string => `project:${id}`

function createCell<T>(initial: T | (() => T)): DraftCell<T> {
  let value = typeof initial === 'function' ? (initial as () => T)() : initial
  const listeners = new Set<() => void>()
  return {
    read: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (update) => {
      const next = typeof update === 'function' ? (update as (prev: T) => T)(value) : update
      if (Object.is(value, next)) return
      value = next
      for (const listener of listeners) listener()
    }
  }
}

/** Like useState, but scoped forms survive navigation within this renderer. */
export function useDraftState<T>(scope: string | undefined, key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const cell = useMemo(() => {
    if (!scope) return createCell(initial)
    let entries = scopes.get(scope)
    if (!entries) {
      entries = new Map()
      scopes.set(scope, entries)
    }
    let entry = entries.get(key)
    if (!entry) {
      entry = createCell(initial) as DraftCell<unknown>
      entries.set(key, entry)
    }
    return entry as DraftCell<T>
  }, [scope, key])
  return [useSyncExternalStore(cell.subscribe, cell.read, cell.read), cell.set]
}

/** Deleting a conversation/project also releases its unsent files and forms. */
export function pruneDrafts(app: Pick<AppState, 'threads' | 'projects'>): void {
  const liveScopes = new Set([
    ...app.threads.map((thread) => threadDraftScope(thread.id)),
    ...app.projects.map((project) => projectDraftScope(project.id))
  ])
  for (const scope of scopes.keys()) if (!liveScopes.has(scope)) scopes.delete(scope)
}
