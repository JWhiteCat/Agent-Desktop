import { describe, expect, it } from 'vitest'
import { catalogFromStorageJson, mergeModelLists } from '../src/shared/model-catalog'
import { modelForChat, pruneFavoriteList } from '../src/renderer/src/lib/model-prefs'
import { describeModel, effortChoices, findVariant, groupModels, listedModelGroups, modelCaption, pickVariant } from '../src/renderer/src/lib/models'
import type { ModelInfo } from '../src/shared/types'
import { GROK_47_500K_HIGH_FAST } from './grok-model'

const GROK_256K_HIGH_FAST = 'grok-4.7[context=256k,reasoning_effort=high,fast=true]'
const GROK_500K_HIGH = 'grok-4.7[context=500k,reasoning_effort=high,fast=false]'

function variant(id: string, legacySlug: string, context: '256k' | '500k', effort: 'low' | 'high', fast: boolean) {
  return {
    parameterValues: [
      { id: 'context', value: context },
      { id: 'reasoning_effort', value: effort },
      { id: 'fast', value: fast ? 'true' : 'false' }
    ],
    variantStringRepresentation: id,
    legacySlug
  }
}

const catalogJson = JSON.stringify({
  models: [
    {
      name: 'grok-4.7',
      clientDisplayName: 'Grok 4.7',
      serverModelName: 'grok-4.7',
      parameterDefinitions: [
        {
          id: 'context',
          parameterType: {
            enumParameter: {
              values: [
                { value: '256k', displayName: '256K' },
                { value: '500k', displayName: '500K' }
              ]
            }
          }
        },
        {
          id: 'reasoning_effort',
          parameterType: {
            enumParameter: {
              values: [
                { value: 'low', displayName: 'Low' },
                { value: 'high', displayName: 'High' }
              ]
            }
          }
        },
        {
          id: 'fast',
          parameterType: {
            booleanParameter: {
              values: [
                { value: 'false' },
                { value: 'true', displayName: 'Fast' }
              ]
            }
          }
        }
      ],
      variants: [
        variant('grok-4.7[context=256k,reasoning_effort=low,fast=false]', 'grok-4.7-low', '256k', 'low', false),
        variant(GROK_256K_HIGH_FAST, 'grok-4.7-high-fast', '256k', 'high', true),
        variant(GROK_500K_HIGH, 'grok-4.7-high', '500k', 'high', false),
        variant(GROK_47_500K_HIGH_FAST, 'grok-4.7-high-fast', '500k', 'high', true)
      ]
    }
  ]
})

function grokModels(): ModelInfo[] {
  const catalog = catalogFromStorageJson(catalogJson)
  return mergeModelLists(
    [
      { id: 'auto', label: 'Auto' },
      { id: 'grok-4.7-high-fast', label: 'Grok 4.7 High Fast' }
    ],
    catalog
  )
}

describe('model catalog', () => {
  it('parses the 500K high fast variant and ignores broken json', () => {
    expect(catalogFromStorageJson('{')).toEqual([])
    const [model] = catalogFromStorageJson(catalogJson)
    expect(model.variants.map((v) => v.id)).toContain(GROK_47_500K_HIGH_FAST)
    const fast = model.variants.find((v) => v.id === GROK_47_500K_HIGH_FAST)
    expect(fast).toMatchObject({ label: 'Grok 4.7 500K High Fast', legacySlug: 'grok-4.7-high-fast' })
  })

  it('expands a flat CLI slug into every context variant', () => {
    const models = grokModels()
    expect(models.map((m) => m.id)).toEqual([
      'auto',
      'grok-4.7[context=256k,reasoning_effort=low,fast=false]',
      GROK_256K_HIGH_FAST,
      GROK_500K_HIGH,
      GROK_47_500K_HIGH_FAST
    ])
    expect(mergeModelLists([{ id: 'auto', label: 'Auto' }], [])).toEqual([{ id: 'auto', label: 'Auto' }])
  })
})

describe('model picker', () => {
  it('selects Grok 4.7 500K High Fast and resolves the flat slug to the smaller context', () => {
    const groups = groupModels(grokModels())
    const grok = groups.find((g) => g.base === 'grok-4.7')
    expect(grok).toBeTruthy()
    const picked = pickVariant(grok!, { context: '500K', effort: 'high', fast: true })
    expect(picked.id).toBe(GROK_47_500K_HIGH_FAST)
    expect(describeModel(groups, picked.id)).toMatchObject({
      name: 'Grok 4.7',
      context: '500K',
      effortLabel: 'High',
      fast: true
    })
    expect(modelCaption(groups, picked.id)).toBe('Grok 4.7 500K High Fast')
    expect(modelCaption([], GROK_47_500K_HIGH_FAST)).toBe('Grok 4.7 500K High Fast')
    expect(modelCaption([], 'grok-4.7[context=256k,reasoning_effort=high,fast=false]')).toBe('Grok 4.7 256K High')
    expect(modelCaption([], 'composer-2.5[fast=true]')).toBe('Composer 2.5 Fast')
    expect(modelCaption([], 'auto')).toBe('Auto')
    const codex = groupModels([
      { id: 'gpt-5.4[high]', label: '5.4 high' },
      { id: 'gpt-5.4[low]', label: '5.4 low' }
    ])
    expect(codex[0].variants.map((variant) => variant.effort)).toEqual(['high', 'low'])
    const astra = groupModels([
      { id: 'gpt-6-astra[max]', label: '6 Astra (max)' },
      { id: 'gpt-6-astra[ultra]', label: '6 Astra (ultra)' }
    ])
    expect(effortChoices(astra[0]).map((choice) => choice.label)).toEqual(['Max', 'Ultra'])
    expect(listedModelGroups(codex, ['grok-4.7'])).toBe(codex)
    expect(listedModelGroups(codex, ['gpt-5.4'])).toEqual(codex)
    expect(pickVariant(grok!, { context: '500K', effort: 'high', fast: false }).id).toBe(GROK_500K_HIGH)
    expect(findVariant(groups, 'grok-4.7-high-fast')?.id).toBe(GROK_256K_HIGH_FAST)
  })

  it('keeps a favorited 500K high fast choice and snaps other models onto it', () => {
    const models = grokModels()
    const favorites = ['grok-4.7']
    expect(modelForChat(models, favorites, 'auto', GROK_47_500K_HIGH_FAST)).toBe(GROK_47_500K_HIGH_FAST)
    expect(modelForChat(models, [], 'auto', 'gpt-5')).toBe('auto')
    expect(modelForChat([{ id: 'auto', label: 'Auto' }], [], 'auto', 'gpt-5')).toBe('gpt-5')
    const other = 'other[context=500k,reasoning_effort=high,fast=true]'
    expect(modelForChat([...models, { id: other, label: 'Other 500K High Fast' }], favorites, other)).toBe(GROK_47_500K_HIGH_FAST)
  })

  it('drops favorite ids that belong to the other CLI', () => {
    const cursor = new Set(['grok-4.7', 'composer-2.5'])
    const codex = new Set(['gpt-5.4', 'gpt-5.4-mini'])
    expect(pruneFavoriteList(['grok-4.7', 'gpt-5.4', 'custom'], cursor, codex)).toEqual(['grok-4.7', 'custom'])
    expect(pruneFavoriteList(['grok-4.7', 'gpt-5.4'], codex, cursor)).toEqual(['gpt-5.4'])
    expect(pruneFavoriteList(['grok-4.7', 'gpt-5.4'], cursor, new Set())).toEqual(['grok-4.7', 'gpt-5.4'])
  })
})
