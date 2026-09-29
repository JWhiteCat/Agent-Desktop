import { normalizeCliProvider, type CliProvider, type Project, type Settings } from '@shared/types'
import { findVariant, groupModels, pickVariant, wantFrom } from '../lib/models'
import {
  defaultModelFor,
  favoritesFor,
  inCatalog,
  modelBases,
  modelForChat,
  projectModelFor,
  pruneFavoriteList,
  sameModel
} from '../lib/model-prefs'
import { getState, setState } from './state'

export const CLI_PROVIDERS: CliProvider[] = ['cursor', 'codex', 'claude']

function cliOf(cli?: CliProvider): CliProvider {
  return cli ?? normalizeCliProvider(getState().app.settings.cliProvider)
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
  const state = getState()
  const other = new Set<string>()
  for (const cli of CLI_PROVIDERS) {
    if (cli === provider) continue
    for (const id of modelBases(state.modelsByCli[cli] ?? [])) other.add(id)
  }
  return other
}

export function rememberModel(projectId: string, model: string, previous?: string, cli?: CliProvider): void {
  const state = getState()
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
  if (Object.hasOwn(patch, 'model') && patch.model === undefined) delete next.model
  if (Object.hasOwn(patch, 'codexModel') && patch.codexModel === undefined) delete next.codexModel
  if (Object.hasOwn(patch, 'claudeModel') && patch.claudeModel === undefined) delete next.claudeModel
  return next
}

export function setDefaultModel(model: string, cli?: CliProvider): void {
  const provider = cliOf(cli)
  if (defaultModelFor(getState().app.settings, provider) === model) return
  const patch = defaultModelPatch(provider, model)
  setState((s) => ({ app: { ...s.app, settings: { ...s.app.settings, ...patch } } }))
  void window.api.updateSettings(patch)
}

export function setFavoriteModels(bases: string[], cli?: CliProvider): void {
  const state = getState()
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

function catalogReady(cli: CliProvider): boolean {
  const list = getState().modelsByCli[cli] ?? []
  return cli === 'cursor' ? list.length > 1 : list.length > 0
}

/** Split a shared favorite list once both catalogs can tell the bases apart. */
export function pruneCrossCliFavorites(): void {
  const state = getState()
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

/** Model a project would use for a new or switched conversation on `cli`. */
export function chatModel(projectId: string, cli: CliProvider): string {
  const state = getState()
  const provider = normalizeCliProvider(cli)
  const project = state.app.projects.find((p) => p.id === projectId)
  const models = state.modelsByCli[provider] ?? state.models
  return modelForChat(models, favoritesFor(state.app.settings, provider), defaultModelFor(state.app.settings, provider), projectModelFor(project, provider))
}
