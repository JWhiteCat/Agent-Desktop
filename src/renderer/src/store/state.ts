import { useSyncExternalStore } from 'react'
import { setLanguage } from '@shared/i18n'
import type { CommandCache, SlashCommand } from '@shared/commands'
import type { AgentMode, AppState, CliProvider, Item, ModelInfo } from '@shared/types'
import { readCommandCache } from './persistence'

export type View = { kind: 'home'; projectId?: string } | { kind: 'thread'; id: string }

export interface UIState {
  app: AppState
  items: Record<string, Item[] | undefined>
  commandsByThread: Record<string, SlashCommand[] | undefined>
  /** Last slash-command list announced by each CLI. Shared by new conversations. */
  commandsByCli: CommandCache
  view: View
  models: ModelInfo[]
  modelsByCli: Record<CliProvider, ModelInfo[]>
  modelErrorByCli: Record<CliProvider, string>
  toast?: { id: number; text: string; level: 'info' | 'error' }
  lastProjectId?: string
}

export interface SendOptions {
  model: string
  mode: AgentMode
  force: boolean
  worktree?: boolean
  cli?: CliProvider
  attachmentIds?: string[]
}

type Listener = () => void

let state: UIState = {
  app: { projects: [], threads: [], settings: {} as AppState['settings'], running: [] },
  items: {},
  commandsByThread: {},
  commandsByCli: readCommandCache(),
  view: { kind: 'home' },
  models: [{ id: 'auto', label: 'Auto' }],
  modelsByCli: { cursor: [{ id: 'auto', label: 'Auto' }], codex: [], claude: [] },
  modelErrorByCli: { cursor: '', codex: '', claude: '' }
}
const listeners = new Set<Listener>()

export function getState(): UIState {
  return state
}

export function setState(patch: Partial<UIState> | ((s: UIState) => Partial<UIState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  if (next.app) setLanguage(next.app.settings.language, next.app.systemLocale ?? (typeof navigator === 'undefined' ? undefined : navigator.language))
  for (const l of listeners) l()
}

export function useStore<T>(selector: (s: UIState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => selector(state)
  )
}
