import type { CliProvider, ModelInfo, Project, Settings } from '@shared/types'
import { findVariant, groupModels, pickVariant, wantFrom } from './models'

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

export function modelBases(models: ModelInfo[]): Set<string> {
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
export function sameModel(models: ModelInfo[], a: string, b: string): boolean {
  if (a === b) return true
  const groups = groupModels(models)
  const left = findVariant(groups, a)
  const right = findVariant(groups, b)
  return !!left && !!right && left.id === right.id
}

export { inCatalog }
