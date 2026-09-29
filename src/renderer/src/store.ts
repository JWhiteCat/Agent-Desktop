import { useSyncExternalStore } from 'react'
import { sanitizeCommandCache, sanitizeSlashCommands, type CommandCache, type SlashCommand } from '@shared/commands'
import { normalizeCliProvider, threadCli, type AgentMode, type AppState, type CliProvider, type Item, type ModelInfo, type Project, type QuestionAnswer, type Settings, type ThreadMeta } from '@shared/types'
import { findVariant, groupModels, pickVariant, wantFrom } from './lib/models'
import {
  defaultModelFor,
  favoritesFor,
  inCatalog,
  modelBases,
  modelForChat,
  projectModelFor,
  pruneFavoriteList,
  sameModel
} from './lib/model-prefs'

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

type Listener = () => void

const COMMANDS_KEY = 'agent-desktop:slash-commands'
const NO_COMMANDS: SlashCommand[] = []

function readCommandCache(): CommandCache {
  try {
    if (typeof localStorage === 'undefined') return {}
    return sanitizeCommandCache(JSON.parse(localStorage.getItem(COMMANDS_KEY) ?? 'null'))
  } catch {
    return {}
  }
}

function writeCommandCache(cache: CommandCache): void {
  try {
    localStorage.setItem(COMMANDS_KEY, JSON.stringify(cache))
  } catch {
    /* Storage can be unavailable. The in-memory list still works for this run. */
  }
}

/** Stable empty list for selectors. A missing cache must not allocate on every read. */
export function cliCommands(s: UIState, cli: CliProvider): SlashCommand[] {
  return s.commandsByCli[cli] ?? NO_COMMANDS
}

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

const CLI_PROVIDERS: CliProvider[] = ['cursor', 'codex', 'claude']

function cliOf(cli?: CliProvider): CliProvider {
  return cli ?? normalizeCliProvider(state.app.settings.cliProvider)
}

function storedProjectModel(project: Project, provider: CliProvider): string | undefined {
  if (provider === 'codex') return project.codexModel
  if (provider === 'claude') return project.claudeModel
  return project.model
}

function projectModelPatch(provider: CliProvider, model: string): Partial<Project> {
  if (provider === 'codex') return { codexModel: model }
  if (provider === 'claude') return { claudeModel: model }
  return { model }
}

function defaultModelPatch(provider: CliProvider, model: string): Partial<Settings> {
  if (provider === 'codex') return { codexDefaultModel: model }
  if (provider === 'claude') return { claudeDefaultModel: model }
  return { defaultModel: model }
}

function favoritePatch(provider: CliProvider, kept: string[]): Partial<Settings> {
  if (provider === 'codex') return { codexFavoriteModels: kept }
  if (provider === 'claude') return { claudeFavoriteModels: kept }
  return { favoriteModels: kept }
}

function otherModelBases(provider: CliProvider): Set<string> {
  const other = new Set<string>()
  for (const cli of CLI_PROVIDERS) {
    if (cli === provider) continue
    for (const id of modelBases(state.modelsByCli[cli] ?? [])) other.add(id)
  }
  return other
}

export function rememberModel(projectId: string, model: string, previous?: string, cli?: CliProvider): void {
  const project = state.app.projects.find((p) => p.id === projectId)
  if (!project) return
  const provider = cliOf(cli)
  const models = state.modelsByCli[provider] ?? state.models
  const stored = storedProjectModel(project, provider)
  const visible = projectModelFor(project, provider)
  if (stored === model) return
  const canonicalizing = previous !== undefined && sameModel(models, previous, model)
  if (canonicalizing) {
    if (!visible || !sameModel(models, visible, model)) return
  } else if (!visible) {
    const fallback = modelForChat(models, favoritesFor(state.app.settings, provider), defaultModelFor(state.app.settings, provider))
    if (sameModel(models, model, fallback)) return
  }
  const patch: Partial<Project> = projectModelPatch(provider, model)
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
  if (patch.claudeModel === undefined) delete next.claudeModel
  return next
}

export function setDefaultModel(model: string, cli?: CliProvider): void {
  const provider = cliOf(cli)
  if (defaultModelFor(state.app.settings, provider) === model) return
  const patch = defaultModelPatch(provider, model)
  setState((s) => ({ app: { ...s.app, settings: { ...s.app.settings, ...patch } } }))
  void window.api.updateSettings(patch)
}

export function setFavoriteModels(bases: string[], cli?: CliProvider): void {
  const provider = cliOf(cli)
  const kept = pruneFavoriteList(bases, modelBases(state.modelsByCli[provider] ?? []), otherModelBases(provider))
  const patch: Partial<Settings> = favoritePatch(provider, kept)
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
    if (snappedDefault) Object.assign(patch, defaultModelPatch(provider, snappedDefault))
    for (const project of state.app.projects) {
      const current = projectModelFor(project, provider)
      if (!current) continue
      const next = snap(current)
      if (!next) continue
      projectPatches.push({ id: project.id, patch: projectModelPatch(provider, next) })
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
function catalogReady(cli: CliProvider): boolean {
  const list = state.modelsByCli[cli] ?? []
  return cli === 'cursor' ? list.length > 1 : list.length > 0
}

function pruneCrossCliFavorites(): void {
  const settings = state.app.settings
  const patch: Partial<Settings> = {}
  let changed = false
  for (const cli of CLI_PROVIDERS) {
    if (!catalogReady(cli)) continue
    const other = new Set<string>()
    for (const peer of CLI_PROVIDERS) {
      if (peer === cli || !catalogReady(peer)) continue
      for (const id of modelBases(state.modelsByCli[peer] ?? [])) other.add(id)
    }
    const current = favoritesFor(settings, cli)
    const next = pruneFavoriteList(current, modelBases(state.modelsByCli[cli] ?? []), other)
    if (sameStringList(next, current)) continue
    Object.assign(patch, favoritePatch(cli, next))
    changed = true
  }
  if (!changed) return
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
    } else if (ev.type === 'commands') {
      const thread = state.app.threads.find((t) => t.id === ev.threadId)
      const cli = thread ? threadCli(thread) : undefined
      const list = sanitizeSlashCommands(ev.commands)
      const commandsByCli = cli ? { ...state.commandsByCli, [cli]: list } : state.commandsByCli
      setState({
        commandsByThread: { ...state.commandsByThread, [ev.threadId]: list },
        commandsByCli
      })
      if (cli) writeCommandCache(commandsByCli)
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
  const models = [...modelsByCli.cursor, ...modelsByCli.codex, ...modelsByCli.claude].filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
  setState({ modelsByCli, models })
  pruneCrossCliFavorites()
}

export async function loadModels(refresh = false, only?: CliProvider): Promise<void> {
  const targets: CliProvider[] = only ? [only] : CLI_PROVIDERS
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
        setModelError(cli, '')
      } catch (err) {
        const loaded = (state.modelsByCli[cli]?.length ?? 0) > (cli === 'cursor' ? 1 : 0)
        setModelError(cli, loaded ? '' : errorText(err))
      }
    })
  )
}

function setModelError(cli: CliProvider, message: string): void {
  if (state.modelErrorByCli[cli] === message) return
  setState((s) => ({ modelErrorByCli: { ...s.modelErrorByCli, [cli]: message } }))
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
  cli?: CliProvider
}

/** Model a project would use for a new or switched conversation on `cli`. */
export function chatModel(projectId: string, cli: CliProvider): string {
  const provider = normalizeCliProvider(cli)
  const project = state.app.projects.find((p) => p.id === projectId)
  const models = state.modelsByCli[provider] ?? state.models
  return modelForChat(models, favoritesFor(state.app.settings, provider), defaultModelFor(state.app.settings, provider), projectModelFor(project, provider))
}

/** Remember which CLI new conversations use. */
export function setCliProvider(cli: CliProvider): void {
  const next = normalizeCliProvider(cli)
  if (normalizeCliProvider(state.app.settings.cliProvider) === next) return
  setState((s) => ({ app: { ...s.app, settings: { ...s.app.settings, cliProvider: next } } }))
  void window.api.updateSettings({ cliProvider: next })
  void loadModels(false, next)
}

export async function answerQuestion(threadId: string, questionId: string, answers: QuestionAnswer[] | null): Promise<void> {
  try {
    await window.api.answerQuestion(threadId, questionId, answers)
  } catch (err) {
    toast(errorText(err), 'error')
    throw err
  }
}

export async function prepareCommands(threadId: string, opts: SendOptions): Promise<void> {
  try {
    const commands = await window.api.prepareCommands(threadId, { model: opts.model, mode: opts.mode, force: opts.force })
    const thread = state.app.threads.find((t) => t.id === threadId)
    const cli = thread ? threadCli(thread) : undefined
    const list = sanitizeSlashCommands(commands)
    setState((s) => {
      const commandsByCli = cli && list.length ? { ...s.commandsByCli, [cli]: list } : s.commandsByCli
      if (cli && list.length) writeCommandCache(commandsByCli)
      return { commandsByThread: { ...s.commandsByThread, [threadId]: list }, commandsByCli }
    })
  } catch (err) {
    toast(errorText(err), 'error')
  }
}

export async function sendMessage(threadId: string, prompt: string, opts: SendOptions): Promise<void> {
  if (!state.items[threadId]) {
    const items = await window.api.getItems(threadId)
    setState((s) => ({ items: { ...s.items, [threadId]: items } }))
  }
  const { cli, ...rest } = opts
  try {
    await window.api.send({ threadId, prompt, ...rest, ...(cli ? { cli } : {}) })
  } catch (err) {
    toast(errorText(err), 'error')
    throw err
  }
}

export async function startThread(projectId: string, prompt: string, opts: SendOptions): Promise<ThreadMeta> {
  const thread = await window.api.createThread(projectId, opts.mode, opts.model, opts.force, opts.cli)
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
