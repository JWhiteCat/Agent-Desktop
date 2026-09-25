import { useSyncExternalStore } from 'react'
import type { AgentMode, AppState, CliProvider, Item, ModelInfo, Project, QuestionAnswer, Settings, ThreadMeta } from '@shared/types'
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

export function favoritesFor(settings: Pick<Settings, 'favoriteModels' | 'codexFavoriteModels'>, cli: CliProvider): string[] {
  return (cli === 'codex' ? settings.codexFavoriteModels : settings.favoriteModels) ?? []
}

export function defaultModelFor(settings: Pick<Settings, 'defaultModel' | 'codexDefaultModel'>, cli: CliProvider): string {
  return cli === 'codex' ? settings.codexDefaultModel : settings.defaultModel
}

/** Last model this project used with `cli`. Codex falls back to the older shared field until it is chosen again. */
export function projectModelFor(project: Pick<Project, 'model' | 'codexModel'> | undefined, cli: CliProvider): string | undefined {
  if (!project) return undefined
  return cli === 'codex' ? project.codexModel ?? project.model : project.model
}

/** Drop ids that belong to the other CLI once that catalog is known. Unknown ids stay. */
export function pruneFavoriteList(bases: string[], own: Set<string>, other: Set<string>): string[] {
  if (!other.size) return bases
  return bases.filter((id) => own.has(id) || !other.has(id))
}

function modelBases(models: ModelInfo[]): Set<string> {
  return new Set(groupModels(models).map((group) => group.base))
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

function cliOf(cli?: CliProvider): CliProvider {
  return cli ?? (state.app.settings.cliProvider === 'codex' ? 'codex' : 'cursor')
}

export function rememberModel(projectId: string, model: string, previous?: string, cli?: CliProvider): void {
  const project = state.app.projects.find((p) => p.id === projectId)
  if (!project) return
  const provider = cliOf(cli)
  const models = state.modelsByCli[provider] ?? state.models
  const stored = provider === 'codex' ? project.codexModel : project.model
  const visible = projectModelFor(project, provider)
  if (stored === model) return
  const canonicalizing = previous !== undefined && sameModel(models, previous, model)
  if (canonicalizing) {
    if (!visible || !sameModel(models, visible, model)) return
  } else if (!visible) {
    const fallback = modelForChat(models, favoritesFor(state.app.settings, provider), defaultModelFor(state.app.settings, provider))
    if (sameModel(models, model, fallback)) return
  }
  const patch: Partial<Project> = provider === 'codex' ? { codexModel: model } : { model }
  if (provider === 'cursor' && !project.codexModel && project.model && project.model !== model) {
    const codexCatalog = state.modelsByCli.codex
    if (inCatalog(codexCatalog, project.model) && !inCatalog(models, project.model)) patch.codexModel = project.model
  }
  if (provider === 'codex' && project.model && inCatalog(models, project.model) && !inCatalog(state.modelsByCli.cursor, project.model)) {
    patch.model = undefined
  }
  setState((s) => ({
    app: {
      ...s.app,
      projects: s.app.projects.map((p) => (p.id === projectId ? applyProjectPatch(p, patch) : p))
    }
  }))
  void window.api.updateProject(projectId, patch)
}

function applyProjectPatch(project: Project, patch: Partial<Project>): Project {
  const next: Project = { ...project, ...patch }
  if (patch.model === undefined) delete next.model
  if (patch.codexModel === undefined) delete next.codexModel
  return next
}

export function setDefaultModel(model: string, cli?: CliProvider): void {
  const provider = cliOf(cli)
  if (provider === 'codex') {
    if (state.app.settings.codexDefaultModel === model) return
    setState((s) => ({ app: { ...s.app, settings: { ...s.app.settings, codexDefaultModel: model } } }))
    void window.api.updateSettings({ codexDefaultModel: model })
    return
  }
  if (state.app.settings.defaultModel === model) return
  setState((s) => ({ app: { ...s.app, settings: { ...s.app.settings, defaultModel: model } } }))
  void window.api.updateSettings({ defaultModel: model })
}

export function setFavoriteModels(bases: string[], cli?: CliProvider): void {
  const provider = cliOf(cli)
  const other: CliProvider = provider === 'codex' ? 'cursor' : 'codex'
  const kept = pruneFavoriteList(bases, modelBases(state.modelsByCli[provider] ?? []), modelBases(state.modelsByCli[other] ?? []))
  const patch: Partial<Settings> = provider === 'codex' ? { codexFavoriteModels: kept } : { favoriteModels: kept }
  const projectPatches: { id: string; patch: Partial<Project> }[] = []
  if (kept.length) {
    const catalog = state.modelsByCli[provider] ?? state.models
    const groups = groupModels(catalog)
    const snap = (modelId: string): string | undefined => {
      if (!inCatalog(catalog, modelId)) return undefined
      const current = findVariant(groups, modelId)
      if (current && kept.includes(current.base)) return undefined
      const group = groups.find((g) => kept.includes(g.base))
      if (!group) return undefined
      const next = pickVariant(group, wantFrom(current)).id
      return next === modelId ? undefined : next
    }
    const snappedDefault = snap(defaultModelFor(state.app.settings, provider) || 'auto')
    if (snappedDefault) {
      if (provider === 'codex') patch.codexDefaultModel = snappedDefault
      else patch.defaultModel = snappedDefault
    }
    for (const project of state.app.projects) {
      const current = projectModelFor(project, provider)
      if (!current) continue
      const next = snap(current)
      if (!next) continue
      projectPatches.push({ id: project.id, patch: provider === 'codex' ? { codexModel: next } : { model: next } })
    }
  }
  setState((s) => ({
    app: {
      ...s.app,
      settings: { ...s.app.settings, ...patch },
      projects: projectPatches.length
        ? s.app.projects.map((p) => {
            const hit = projectPatches.find((x) => x.id === p.id)
            return hit ? applyProjectPatch(p, hit.patch) : p
          })
        : s.app.projects
    }
  }))
  void window.api.updateSettings(patch)
  for (const project of projectPatches) void window.api.updateProject(project.id, project.patch)
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/** Split a shared favorite list once both catalogs can tell the bases apart. */
function pruneCrossCliFavorites(): void {
  const cursorBases = modelBases(state.modelsByCli.cursor)
  const codexBases = modelBases(state.modelsByCli.codex)
  if (!cursorBases.size || !codexBases.size) return
  const settings = state.app.settings
  const favoriteModels = pruneFavoriteList(settings.favoriteModels ?? [], cursorBases, codexBases)
  const codexFavoriteModels = pruneFavoriteList(settings.codexFavoriteModels ?? [], codexBases, cursorBases)
  if (sameStringList(favoriteModels, settings.favoriteModels ?? []) && sameStringList(codexFavoriteModels, settings.codexFavoriteModels ?? [])) return
  const patch = { favoriteModels, codexFavoriteModels }
  setState((s) => ({ app: { ...s.app, settings: { ...s.app.settings, ...patch } } }))
  void window.api.updateSettings(patch)
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
  pruneCrossCliFavorites()
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
