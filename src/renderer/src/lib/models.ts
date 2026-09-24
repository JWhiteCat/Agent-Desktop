import type { ModelInfo } from '@shared/types'

export interface ModelVariant {
  id: string
  label: string
  base: string
  context?: string
  effort?: string
  thinking: boolean
  fast: boolean
}

export interface ModelGroup {
  base: string
  name: string
  variants: ModelVariant[]
}

export interface EffortChoice {
  effort?: string
  thinking: boolean
  label: string
}

export interface VariantWant {
  context?: string
  effort?: string
  thinking?: boolean
  fast?: boolean
}

export interface ModelSummary {
  id: string
  name: string
  context?: string
  effortLabel?: string
  fast: boolean
}

const EFFORT_SUFFIXES = ['extra-high', 'xhigh', 'minimal', 'medium', 'none', 'high', 'low', 'max'] as const
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max']
const PREFER_EFFORT = ['high', 'medium', 'xhigh', 'extra-high', 'max', 'low', 'minimal', 'none']

const EFFORT_LABEL: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  'extra-high': 'Extra High',
  max: 'Max'
}

function parseId(id: string): { base: string; effort?: string; thinking: boolean; fast: boolean } {
  let rest = id
  let fast = false
  if (rest.endsWith('-fast')) {
    fast = true
    rest = rest.slice(0, -5)
  }
  let thinking = false
  const stripThinking = () => {
    if (rest.endsWith('-thinking')) {
      thinking = true
      rest = rest.slice(0, -9)
    }
  }
  stripThinking()
  let effort: string | undefined
  for (const suffix of EFFORT_SUFFIXES) {
    const token = `-${suffix}`
    if (rest.endsWith(token) && rest.length > token.length) {
      effort = suffix
      rest = rest.slice(0, -token.length)
      break
    }
  }
  stripThinking()
  return { base: rest, effort, thinking, fast }
}

function cleanLabel(label: string): string {
  return label.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim()
}

function readContext(label: string): string | undefined {
  const match = cleanLabel(label).match(/\b(\d+(?:\.\d+)?)([kKmM])\b/)
  return match ? `${match[1]}${match[2].toUpperCase()}` : undefined
}

function displayName(label: string): string {
  return cleanLabel(label)
    .replace(/\s*\([^)]*\)/g, ' ')
    .replace(/\b\d+(?:\.\d+)?[kKmM]\b/g, ' ')
    .replace(/\b(?:Extra High|High|Medium|Low|Max|None|Minimal|Thinking|Fast)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function contextSize(context: string): number {
  const match = context.match(/^(\d+(?:\.\d+)?)([KM])$/)
  if (!match) return 0
  const n = Number(match[1])
  return match[2] === 'M' ? n * 1_000_000 : n * 1_000
}

function mostCommonName(labels: string[]): string {
  const counts = new Map<string, number>()
  for (const label of labels) {
    const name = displayName(label)
    if (!name) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? labels[0] ?? ''
}

export function effortText(effort?: string, thinking?: boolean): string | undefined {
  const base = effort ? (EFFORT_LABEL[effort] ?? effort) : undefined
  if (thinking && base) return `${base} Thinking`
  if (thinking) return 'Thinking'
  return base
}

export function groupModels(models: ModelInfo[]): ModelGroup[] {
  const groups: ModelGroup[] = []
  const byBase = new Map<string, ModelGroup>()
  for (const model of models) {
    const parsed = parseId(model.id)
    let group = byBase.get(parsed.base)
    if (!group) {
      group = { base: parsed.base, name: parsed.base, variants: [] }
      byBase.set(parsed.base, group)
      groups.push(group)
    }
    group.variants.push({
      id: model.id,
      label: cleanLabel(model.label),
      base: parsed.base,
      context: readContext(model.label),
      effort: parsed.effort,
      thinking: parsed.thinking,
      fast: parsed.fast
    })
  }
  for (const group of groups) {
    const contexts = [...new Set(group.variants.map((v) => v.context).filter((c): c is string => !!c))]
    if (contexts.length === 1) {
      for (const variant of group.variants) variant.context = contexts[0]
    }
    group.name = mostCommonName(group.variants.map((v) => v.label)) || group.base
  }
  return groups
}

export function findVariant(groups: ModelGroup[], id: string): ModelVariant | undefined {
  for (const group of groups) {
    const variant = group.variants.find((v) => v.id === id)
    if (variant) return variant
  }
  return undefined
}

export function describeModel(groups: ModelGroup[], id: string): ModelSummary {
  const variant = findVariant(groups, id)
  if (!variant) return { id, name: id, fast: false }
  const group = groups.find((g) => g.base === variant.base)
  return {
    id,
    name: group?.name ?? variant.base,
    context: variant.context,
    effortLabel: effortText(variant.effort, variant.thinking),
    fast: variant.fast
  }
}

export function contextChoices(group: ModelGroup): string[] {
  return [...new Set(group.variants.map((v) => v.context).filter((c): c is string => !!c))].sort((a, b) => contextSize(b) - contextSize(a))
}

export function effortChoices(group: ModelGroup): EffortChoice[] {
  const map = new Map<string, EffortChoice>()
  for (const variant of group.variants) {
    const key = `${variant.effort ?? ''}\0${variant.thinking ? 1 : 0}`
    if (map.has(key)) continue
    map.set(key, {
      effort: variant.effort,
      thinking: variant.thinking,
      label: effortText(variant.effort, variant.thinking) ?? '默认'
    })
  }
  const all = [...map.values()].sort((a, b) => effortRank(a) - effortRank(b))
  if (all.length === 1 && !all[0].effort && !all[0].thinking) return []
  return all
}

function effortRank(choice: EffortChoice): number {
  if (!choice.effort && !choice.thinking) return -1
  const index = choice.effort ? EFFORT_ORDER.indexOf(choice.effort) : EFFORT_ORDER.length
  return (index === -1 ? EFFORT_ORDER.length : index) * 2 + (choice.thinking ? 1 : 0)
}

export function hasFastVariant(group: ModelGroup): boolean {
  return group.variants.some((v) => v.fast)
}

function preferScore(variant: ModelVariant): number {
  const index = variant.effort ? PREFER_EFFORT.indexOf(variant.effort) : PREFER_EFFORT.length
  return (index === -1 ? 80 : index) * 2 + (variant.thinking ? 1 : 0)
}

export function pickVariant(group: ModelGroup, want: VariantWant): ModelVariant {
  let pool = group.variants
  if (!pool.length) throw new Error('模型没有可选变体')
  if (want.context) {
    const matched = pool.filter((v) => v.context === want.context)
    if (matched.length) pool = matched
  }

  if (want.effort !== undefined || want.thinking !== undefined) {
    const matched = pool.filter((v) => v.effort === want.effort && v.thinking === !!want.thinking)
    if (matched.length) pool = matched
  }

  const sameEffort = pool.every((v) => v.effort === pool[0].effort && v.thinking === pool[0].thinking)
  if (!sameEffort) {
    const best = [...pool].sort((a, b) => preferScore(a) - preferScore(b))[0]
    pool = pool.filter((v) => v.effort === best.effort && v.thinking === best.thinking)
  }

  if (want.fast) {
    const fast = pool.find((v) => v.fast)
    if (fast) return fast
  }
  return pool.find((v) => !v.fast) ?? pool[0]
}

export function wantFrom(variant: ModelVariant | undefined): VariantWant {
  if (!variant || variant.base === 'auto') return {}
  return { context: variant.context, effort: variant.effort, thinking: variant.thinking, fast: variant.fast }
}

export function speedAvailable(group: ModelGroup, current: ModelVariant, fast: boolean): boolean {
  return group.variants.some(
    (v) => v.fast === fast && v.context === current.context && v.effort === current.effort && v.thinking === current.thinking
  )
}
