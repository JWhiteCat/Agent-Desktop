import { useSyncExternalStore } from 'react'
import type { AgentMode, AppState, Item, ModelInfo, ThreadMeta } from '@shared/types'

export type View = { kind: 'home'; projectId?: string } | { kind: 'thread'; id: string }

export interface UIState {
  app: AppState
  items: Record<string, Item[] | undefined>
  view: View
  models: ModelInfo[]
  toast?: { id: number; text: string; level: 'info' | 'error' }
  lastProjectId?: string
}

type Listener = () => void

let state: UIState = {
  app: { projects: [], threads: [], settings: {} as AppState['settings'], running: [] },
  items: {},
  view: { kind: 'home' },
  models: [{ id: 'auto', label: 'Auto' }]
}
const listeners = new Set<Listener>()

export function getState(): UIState {
  return state
}

export function setState(patch: Partial<UIState> | ((s: UIState) => Partial<UIState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
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

const LAST_PROJECT_KEY = 'agent-desktop:lastProject'

export async function initStore(): Promise<void> {
  const app = await window.api.getState()
  const saved = localStorage.getItem(LAST_PROJECT_KEY) ?? undefined
  const lastProjectId = app.projects.some((p) => p.id === saved) ? saved : app.projects[0]?.id
  setState({ app, lastProjectId, view: { kind: 'home', projectId: lastProjectId } })

  window.api.onState((app) => setState({ app }))
  window.api.onEvent((ev) => {
    if (ev.type === 'items') {
      setState((s) => {
        const current = s.items[ev.threadId]
        if (!current) return {}
        const next = current.slice()
        const index = new Map(next.map((it, i) => [it.id, i]))
        for (const it of ev.items) {
          const i = index.get(it.id)
          if (i === undefined) {
            index.set(it.id, next.length)
            next.push(it)
          } else next[i] = it
        }
        return { items: { ...s.items, [ev.threadId]: next } }
      })
    } else if (ev.type === 'running' && !ev.running) {
      const v = state.view
      if (v.kind === 'thread' && v.id === ev.threadId && document.hasFocus()) {
        window.api.updateThread(ev.threadId, { unread: false })
      }
    }
  })

  loadModels()
}

const MODELS_KEY = 'agent-desktop:models'

export async function loadModels(refresh = false): Promise<void> {
  if (!refresh) {
    try {
      const cached = JSON.parse(localStorage.getItem(MODELS_KEY) ?? 'null') as ModelInfo[] | null
      if (cached?.length) setState({ models: cached })
    } catch {
      /* ignore corrupt cache */
    }
  }
  try {
    const models = await window.api.listModels(refresh)
    setState({ models })
    if (models.length > 1) localStorage.setItem(MODELS_KEY, JSON.stringify(models))
  } catch {
    /* keep defaults */
  }
}

let toastSeq = 0
export function toast(text: string, level: 'info' | 'error' = 'info'): void {
  const id = ++toastSeq
  setState({ toast: { id, text, level } })
  setTimeout(() => {
    if (state.toast?.id === id) setState({ toast: undefined })
  }, level === 'error' ? 6000 : 3000)
}

export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function rememberProject(projectId: string): void {
  localStorage.setItem(LAST_PROJECT_KEY, projectId)
  setState({ lastProjectId: projectId })
}

export async function openThread(id: string): Promise<void> {
  setState({ view: { kind: 'thread', id } })
  const thread = state.app.threads.find((t) => t.id === id)
  if (thread) rememberProject(thread.projectId)
  const idle = !state.app.running.includes(id)
  if (!state.items[id] || (thread?.source === 'cli' && idle)) {
    const items = await window.api.getItems(id)
    setState((s) => ({ items: { ...s.items, [id]: s.items[id] && !idle ? s.items[id] : items } }))
  }
  if (thread?.unread) window.api.updateThread(id, { unread: false })
}

export async function syncThreadFromCli(id: string): Promise<void> {
  try {
    const items = await window.api.syncFromCli(id)
    setState((s) => ({ items: { ...s.items, [id]: items } }))
    toast(`已从 CLI 同步 ${items.length} 条记录`)
  } catch (err) {
    toast(errorText(err), 'error')
  }
}

export function goHome(projectId?: string): void {
  const pid = projectId ?? state.lastProjectId ?? state.app.projects[0]?.id
  if (pid) rememberProject(pid)
  setState({ view: { kind: 'home', projectId: pid } })
}

export interface SendOptions {
  model: string
  mode: AgentMode
  force: boolean
  worktree?: boolean
}

export async function sendMessage(threadId: string, prompt: string, opts: SendOptions): Promise<void> {
  if (!state.items[threadId]) {
    const items = await window.api.getItems(threadId)
    setState((s) => ({ items: { ...s.items, [threadId]: items } }))
  }
  try {
    await window.api.send({ threadId, prompt, ...opts })
  } catch (err) {
    toast(errorText(err), 'error')
    throw err
  }
}

export async function startThread(projectId: string, prompt: string, opts: SendOptions): Promise<ThreadMeta> {
  const thread = await window.api.createThread(projectId, opts.mode, opts.model)
  setState((s) => ({
    app: s.app.threads.some((t) => t.id === thread.id) ? s.app : { ...s.app, threads: [...s.app.threads, thread] },
    items: { ...s.items, [thread.id]: [] },
    view: { kind: 'thread', id: thread.id }
  }))
  rememberProject(projectId)
  await sendMessage(thread.id, prompt, opts)
  return thread
}

export async function addProjectInteractive(): Promise<string | undefined> {
  try {
    const p = await window.api.pickProject()
    if (p) {
      rememberProject(p.id)
      return p.id
    }
  } catch (err) {
    toast(errorText(err), 'error')
  }
  return undefined
}
