import type { ModelInfo } from './types'

interface EnumValue {
  value?: string
  displayName?: string
}

interface ParamDef {
  id?: string
  parameterType?: {
    enumParameter?: { values?: EnumValue[] }
    booleanParameter?: { values?: EnumValue[] }
  }
}

interface CatalogVariant {
  parameterValues?: { id?: string; value?: string }[]
  variantStringRepresentation?: string
  legacySlug?: string
}

interface CatalogEntry {
  name?: string
  clientDisplayName?: string
  serverModelName?: string
  parameterDefinitions?: ParamDef[]
  variants?: CatalogVariant[]
}

export interface CatalogModel {
  name: string
  variants: ModelInfo[]
}

function isEntry(node: unknown): node is CatalogEntry {
  if (!node || typeof node !== 'object') return false
  const entry = node as CatalogEntry
  return (
    typeof entry.name === 'string' &&
    (typeof entry.clientDisplayName === 'string' || typeof entry.serverModelName === 'string') &&
    Array.isArray(entry.parameterDefinitions) &&
    Array.isArray(entry.variants) &&
    entry.variants.length > 0
  )
}

function paramText(def: ParamDef, value: string): string | undefined {
  const choices = def.parameterType?.enumParameter?.values ?? def.parameterType?.booleanParameter?.values
  const match = choices?.find((item) => item.value === value)
  if (def.id === 'fast' || def.id === 'speed') {
    if (value === 'true' || value === 'fast') return match?.displayName?.trim() || 'Fast'
    return undefined
  }
  if (def.id === 'thinking') return value === 'true' ? 'Thinking' : undefined
  const named = match?.displayName?.replace(/[\u200b-\u200d\ufeff]/g, '').trim()
  if (named) return named
  if (def.id === 'context') {
    const size = value.match(/^(\d+(?:\.\d+)?)([kKmM])$/)
    if (size) return `${size[1]}${size[2].toUpperCase()}`
  }
  return undefined
}

function variantId(name: string, variant: CatalogVariant, defs: ParamDef[]): string | undefined {
  const given = variant.variantStringRepresentation?.trim()
  if (given) return given
  const params = new Map((variant.parameterValues ?? []).map((item) => [item.id, item.value]))
  const parts = defs.flatMap((def) => {
    const value = def.id ? params.get(def.id) : undefined
    return def.id && value ? [`${def.id}=${value}`] : []
  })
  return parts.length ? `${name}[${parts.join(',')}]` : undefined
}

function variantLabel(displayName: string, variant: CatalogVariant, defs: ParamDef[]): string {
  const params = new Map((variant.parameterValues ?? []).map((item) => [item.id, item.value]))
  const bits = [displayName]
  for (const def of defs) {
    const value = def.id ? params.get(def.id) : undefined
    if (!value) continue
    const text = paramText(def, value)
    if (text) bits.push(text)
  }
  return bits.join(' ')
}

export function catalogFromStorageJson(text: string): CatalogModel[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const byName = new Map<string, CatalogEntry>()
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (isEntry(node) && node.name) {
      const prev = byName.get(node.name)
      if (!prev || (node.variants?.length ?? 0) > (prev.variants?.length ?? 0)) byName.set(node.name, node)
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(data)

  const models: CatalogModel[] = []
  for (const entry of byName.values()) {
    const name = entry.name
    if (!name) continue
    const defs = entry.parameterDefinitions ?? []
    const displayName = (entry.clientDisplayName || entry.serverModelName || name).trim()
    const variants: ModelInfo[] = []
    const seen = new Set<string>()
    for (const variant of entry.variants ?? []) {
      const id = variantId(name, variant, defs)
      if (!id || seen.has(id)) continue
      seen.add(id)
      variants.push({
        id,
        label: variantLabel(displayName, variant, defs),
        legacySlug: variant.legacySlug?.trim() || undefined
      })
    }
    if (variants.length) models.push({ name, variants })
  }
  return models
}

/** Expand flat CLI slugs into every parameterized context/effort/speed variant. */
export function mergeModelLists(flat: ModelInfo[], catalog: CatalogModel[]): ModelInfo[] {
  if (!catalog.length) return flat
  const byLegacy = new Map<string, CatalogModel>()
  for (const model of catalog) {
    for (const variant of model.variants) {
      if (variant.legacySlug && !byLegacy.has(variant.legacySlug)) byLegacy.set(variant.legacySlug, model)
    }
  }
  const emitted = new Set<string>()
  const out: ModelInfo[] = []
  for (const model of flat) {
    const parameterized = byLegacy.get(model.id)
    if (!parameterized) {
      if (!emitted.has(model.id)) {
        emitted.add(model.id)
        out.push(model)
      }
      continue
    }
    const key = `catalog:${parameterized.name}`
    if (emitted.has(key)) continue
    emitted.add(key)
    for (const variant of parameterized.variants) {
      if (emitted.has(variant.id)) continue
      emitted.add(variant.id)
      out.push(variant)
    }
  }
  return out
}
