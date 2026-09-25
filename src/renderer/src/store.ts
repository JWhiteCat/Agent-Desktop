import { useSyncExternalStore } from 'react'
import type { AgentMode, AppState, CliProvider, Item, ModelInfo, QuestionAnswer, Settings, ThreadMeta } from '@shared/types'
import { findVariant, groupModels, pickVariant, wantFrom } from './lib/models'

export type View = { kind: 'home'; projectId?: string } | { kind: 'thread'; id: string }

export interface UIState {
  app: AppState
  items: Record<string, Item[] | undefined>
  view: View
  models: ModelInfo[]
  modelsByCli: Record<CliProvider, ModelInfo[]>
  toast?: { id: number; text: string; level: 'info' | 'error' }
  lastProjectId?: string
}

type Listener = () => void

let state: UIState = {
  app: { projects: [], threads: [], settings: {} as AppState['settings'], running: [] },
  items: {},
  view: { kind: 'home' },
  models: [{ id: 'auto', label: 'Auto' }],
  modelsByCli: { cursor: [{ id: 'auto', label: 'Auto' }], codex: [] }
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
const LEGACY_MODEL_KEY = 'agent-desktop:model'

function inCatalog(models: ModelInfo[], id: string | undefined): boolean {
  if (!id) return false
  if (models.some((model) => model.id === id || model.legacySlug === id)) return true
  return !!findVariant(groupModels(models), id)
}

/** Model shown for a new chat in a project: that project's last choice, otherwise the global default. */
export function modelForChat(models: ModelInfo[], favoriteBases: string[] | undefined, settingsDefault?: string, projectModel?: string): string {
  const loaded = models.some((model) => model.id !== 'auto')
  if (!loaded) return projectModel || settingsDefault || models[0]?.id || 'auto'
  const fallback = inCatalog(models, settingsDefault) ? settingsDefault! : (models.find((model) => model.id !== 'auto')?.id ?? models[0].id)
  const preferred = inCatalog(models, projectModel) ? projectModel! : fallback
  return resolveModel(models, favoriteBases, preferred)
}

function resolveModel(models: ModelInfo[], favoriteBases: string[] | undefined, preferred: string): string {
  const favorites = favoriteBases ?? []
  if (!favorites.length) return preferred
  const groups = groupModels(models)
  const current = findVariant(groups, preferred)
  if (current && favorites.includes(current.base)) return preferred
  const group = groups.find((g) => favorites.includes(g.base))
  if (!group) return preferred
  return pickVariant(group, wantFrom(current)).id
}

/** Same catalog entry, including a legacy slug and its parameterized id. */
function sameModel(models: ModelInfo[], a: string, b: string): boolean {
  if (a === b) return true
  const groups = groupModels(models)
  const left = findVariant(groups, a)
  const right = findVariant(groups, b)
  return !!left && !!right && left.id === right.id
}

export function rememberModel(projectId: string, model: string, previous?: string, cli?: CliProvider): void {
  const project = state.app.projects.find((p) => p.id === projectId)
  if (!project || project.model === model) return
  const provider: CliProvider = cli ?? (state.app.settings.cliProvider === 'codex' ? 'codex' : 'cursor')
  const models = state.modelsByCli[provider] ?? state.models
  const settingsDefault = provider === 'codex' ? state.app.settings.codexDefaultModel : state.app.settings.defaultModel
  const canonicalizing = previous !== undefined && sameModel(models, previous, model)
  if (canonicalizing) {
    if (!project.model || !sameModel(models, project.model, model)) return
  } else if (!project.model) {
    const fallback = modelForChat(models, state.app.settings.favoriteModels, settingsDefault)
    if (sameModel(models, model, fallback)) return
  }
  setState((s) => ({
    app: {
      ...s.app,
      projects: s.app.projects.map((p) => (p.id === projectId ? { ...p, model } : p))
    }
  }))
  void window.api.updateProject(projectId, { model })
}

export function setDefaultModel(model: string): void {
  if (state.app.settings.cliProvider === 'codex') {
    if (state.app.settings.codexDefaultModel === model) return
    setState((s) => ({ app: { ...s.app, settings: { ...s.app.settings, codexDefaultModel: model } } }))
    void window.api.updateSettings({ codexDefaultModel: model })
    return
  }
  if (state.app.settings.defaultModel === model) return
  setState((s) => ({ app: { ...s.app, settings: { ...s.app.settings, defaultModel: model } } }))
  void window.api.updateSettings({ defaultModel: model })
}

export function setFavoriteModels(bases: string[]): void {
  const patch: Partial<Settings> = { favoriteModels: bases }
  const projectPatches: { id: string; model: string }[] = []
  if (bases.length) {
    const provider: CliProvider = state.app.settings.cliProvider === 'codex' ? 'codex' : 'cursor'
    const catalog = state.modelsByCli[provider] ?? state.models
    const groups = groupModels(catalog)
    const snap = (modelId: string): string | undefined => {
      if (!inCatalog(catalog, modelId)) return undefined
      const current = findVariant(groups, modelId)
      if (current && bases.includes(current.base)) return undefined
      const group = groups.find((g) => bases.includes(g.base))
      if (!group) return undefined
      const next = pickVariant(group, wantFrom(current)).id
      return next === modelId ? undefined : next
    }
    const snappedDefault = snap(provider === 'codex' ? state.app.settings.codexDefaultModel : state.app.settings.defaultModel || 'auto')
    if (snappedDefault) {
      if (provider === 'codex') patch.codexDefaultModel = snappedDefault
      else patch.defaultModel = snappedDefault
    }
    for (const project of state.app.projects) {
      if (!project.model) continue
      const next = snap(project.model)
      if (next) projectPatches.push({ id: project.id, model: next })
    }
  }
  setState((s) => ({
    app: {
      ...s.app,
      settings: { ...s.app.settings, ...patch },
      projects: projectPatches.length
        ? s.app.projects.map((p) => {
            const hit = projectPatches.find((x) => x.id === p.id)
            return hit ? { ...p, model: hit.model } : p
          })
        : s.app.projects
    }
  }))
  void window.api.updateSettings(patch)
  for (const project of projectPatches) void window.api.updateProject(project.id, { model: project.model })
}

export async function initStore(): Promise<void> {
  let app = await window.api.getState()
  const saved = localStorage.getItem(LAST_PROJECT_KEY) ?? undefined
  const lastProjectId = app.projects.some((p) => p.id === saved) ? saved : app.projects[0]?.id
  const legacyModel = localStorage.getItem(LEGACY_MODEL_KEY)
  if (legacyModel) {
    localStorage.removeItem(LEGACY_MODEL_KEY)
    if (legacyModel !== app.settings.defaultModel) {
      app = { ...app, settings: { ...app.settings, defaultModel: legacyModel } }
      void window.api.updateSettings({ defaultModel: legacyModel })
    }
  }
  setState({ app, lastProjectId, view: { kind: 'home', projectId: lastProjectId } })

  window.api.onState((app) => setState({ app }))
  window.api.onFocusThread((id) => {
    void openThread(id)
  })
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

function cacheKey(cli: CliProvider): string {
  return cli === 'cursor' ? MODELS_KEY : `${MODELS_KEY}:${cli}`
}

function readModelCache(cli: CliProvider): ModelInfo[] | null {
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey(cli)) ?? 'null') as ModelInfo[] | null
    return cached?.length ? cached : null
  } catch {
    return null
  }
}

function publishModels(cli: CliProvider, list: ModelInfo[]): void {
  const modelsByCli = { ...state.modelsByCli, [cli]: list }
  const seen = new Set<string>()
  const models = [...modelsByCli.cursor, ...modelsByCli.codex].filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
  setState({ modelsByCli, models })
}

export async function loadModels(refresh = false, only?: CliProvider): Promise<void> {
  const targets: CliProvider[] = only ? [only] : ['cursor', 'codex']
  if (!refresh) {
    for (const cli of targets) {
      const cached = readModelCache(cli)
      if (cached) publishModels(cli, cached)
    }
  }
  await Promise.all(
    targets.map(async (cli) => {
      try {
        const models = await window.api.listModels(refresh, cli)
        publishModels(cli, models)
        if (models.length > (cli === 'cursor' ? 1 : 0)) localStorage.setItem(cacheKey(cli), JSON.stringify(models))
      } catch {
        /* keep the cached list */
      }
    })
  )
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

export async function forkThread(threadId: string, throughItemId?: string): Promise<void> {
  try {
    const result = await window.api.forkThread(threadId, throughItemId)
    const thread = result.thread
    setState((s) => ({
      app: s.app.threads.some((t) => t.id === thread.id) ? s.app : { ...s.app, threads: [...s.app.threads, thread] },
      items: { ...s.items, [thread.id]: result.items },
      view: { kind: 'thread', id: thread.id }
    }))
    rememberProject(thread.projectId)
    toast(`已分叉为「${thread.title}」`)
  } catch (err) {
    toast(errorText(err), 'error')
  }
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

export async function answerQuestion(threadId: string, questionId: string, answers: QuestionAnswer[] | null): Promise<void> {
  try {
    await window.api.answerQuestion(threadId, questionId, answers)
  } catch (err) {
    toast(errorText(err), 'error')
    throw err
  }
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
