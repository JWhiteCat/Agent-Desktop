import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/main/store'
import { DEFAULT_SETTINGS, type ModelInfo, type ModelPreference } from '../src/shared/types'
import { modelForChat, pickRememberedVariant } from '../src/renderer/src/lib/model-prefs'
import { findVariant, groupModels, type ModelGroup } from '../src/renderer/src/lib/models'
import { getState, rememberModelVariant, setState } from '../src/renderer/src/store'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData' || !electron.userData) throw new Error(`Unexpected app path: ${name}`)
      return electron.userData
    }
  }
}))

const GROK_LONG_FAST = 'grok-4.7[context=500k,reasoning_effort=high,fast=true]'
const GROK_SHORT_STANDARD = 'grok-4.7[context=256k,reasoning_effort=low,fast=false]'
const GROK_LONG_STANDARD = 'grok-4.7[context=500k,reasoning_effort=high,fast=false]'
const COMPOSER_FAST = 'composer-2.5[fast=true]'
const COMPOSER_STANDARD = 'composer-2.5[fast=false]'
const THINKING_ON = 'sonnet[thinking=true,fast=false]'
const THINKING_OFF = 'sonnet[thinking=false,fast=false]'

const models: ModelInfo[] = [
  { id: 'auto', label: 'Auto' },
  { id: GROK_SHORT_STANDARD, label: 'Grok 4.7 256K Low' },
  { id: GROK_LONG_STANDARD, label: 'Grok 4.7 500K High' },
  { id: GROK_LONG_FAST, label: 'Grok 4.7 500K High Fast', legacySlug: 'grok-4.7-high-fast' },
  { id: COMPOSER_STANDARD, label: 'Composer 2.5' },
  { id: COMPOSER_FAST, label: 'Composer 2.5 Fast' },
  { id: THINKING_OFF, label: 'Sonnet' },
  { id: THINKING_ON, label: 'Sonnet Thinking' }
]
const groups = groupModels(models)
const longFast: ModelPreference = { context: '500K', effort: 'high', thinking: false, fast: true }
const shortStandard: ModelPreference = { context: '256K', effort: 'low', thinking: false, fast: false }

function group(base: string): ModelGroup {
  return groups.find((item) => item.base === base)!
}

describe('model parameter preferences', () => {
  const updateSettings = vi.fn()

  beforeEach(() => {
    updateSettings.mockReset()
    vi.stubGlobal('window', { api: { updateSettings } })
    setState({
      app: { projects: [], threads: [], settings: { ...DEFAULT_SETTINGS, modelPreferences: {} }, running: [] },
      models,
      modelsByCli: { cursor: models, codex: models, claude: models }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('restores context, effort and Fast after switching through a model with fewer options', () => {
    rememberModelVariant(GROK_LONG_FAST, undefined, 'cursor')
    rememberModelVariant(COMPOSER_STANDARD, GROK_LONG_FAST, 'cursor')

    const saved = getState().app.settings.modelPreferences.cursor
    const restored = pickRememberedVariant(group('grok-4.7'), saved, findVariant(groups, COMPOSER_STANDARD))

    expect(restored.id).toBe(GROK_LONG_FAST)
    expect(saved?.['composer-2.5']).toMatchObject({ thinking: false, fast: false })
    expect(saved?.['grok-4.7']).toEqual(longFast)
  })

  it('persists a parameter change within one model and captures explicit false values', () => {
    rememberModelVariant(GROK_LONG_FAST, undefined, 'cursor')
    rememberModelVariant(GROK_SHORT_STANDARD, GROK_LONG_FAST, 'cursor')
    rememberModelVariant(THINKING_ON, undefined, 'cursor')
    rememberModelVariant(THINKING_OFF, THINKING_ON, 'cursor')

    const saved = getState().app.settings.modelPreferences.cursor
    expect(saved?.['grok-4.7']).toEqual(shortStandard)
    expect(saved?.sonnet).toMatchObject({ thinking: false, fast: false })
    expect(pickRememberedVariant(group('grok-4.7'), saved).id).toBe(GROK_SHORT_STANDARD)
    expect(pickRememberedVariant(group('sonnet'), saved).id).toBe(THINKING_OFF)
  })

  it('seeds the previous selection and the new selection in one persistence update', () => {
    rememberModelVariant(COMPOSER_STANDARD, GROK_LONG_FAST, 'cursor')

    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({
      modelPreferences: {
        cursor: {
          'grok-4.7': longFast,
          'composer-2.5': { thinking: false, fast: false }
        }
      }
    })
  })

  it('does not overwrite a remembered preference with an old conversation selection', () => {
    rememberModelVariant(GROK_LONG_FAST, undefined, 'cursor')
    rememberModelVariant(COMPOSER_FAST, GROK_SHORT_STANDARD, 'cursor')

    expect(getState().app.settings.modelPreferences.cursor?.['grok-4.7']).toEqual(longFast)
  })

  it('keeps preferences independent for providers that expose the same model base', () => {
    rememberModelVariant(GROK_LONG_FAST, undefined, 'cursor')
    rememberModelVariant(GROK_SHORT_STANDARD, undefined, 'codex')
    rememberModelVariant(GROK_LONG_STANDARD, undefined, 'claude')

    const saved = getState().app.settings.modelPreferences
    expect(saved.cursor?.['grok-4.7']).toEqual(longFast)
    expect(saved.codex?.['grok-4.7']).toEqual(shortStandard)
    expect(saved.claude?.['grok-4.7']).toEqual({ ...longFast, fast: false })
  })

  it('uses the active provider when the caller does not specify one', () => {
    setState((state) => ({ app: { ...state.app, settings: { ...state.app.settings, cliProvider: 'codex' } } }))

    rememberModelVariant(COMPOSER_FAST)

    expect(getState().app.settings.modelPreferences).toEqual({
      codex: { 'composer-2.5': { thinking: false, fast: true } }
    })
  })

  it('does not write duplicate choices, auto selections or unknown models', () => {
    rememberModelVariant(GROK_LONG_FAST, undefined, 'cursor')
    updateSettings.mockClear()

    rememberModelVariant(GROK_LONG_FAST, undefined, 'cursor')
    rememberModelVariant('auto', undefined, 'cursor')
    rememberModelVariant('unknown-model', undefined, 'cursor')

    expect(updateSettings).not.toHaveBeenCalled()
    expect(getState().app.settings.modelPreferences).toEqual({ cursor: { 'grok-4.7': longFast } })
  })

  it('resolves a legacy alias into the same model preference entry', () => {
    rememberModelVariant('grok-4.7-high-fast', undefined, 'cursor')

    expect(getState().app.settings.modelPreferences).toEqual({ cursor: { 'grok-4.7': longFast } })
  })

  it('uses saved parameters when favorites force a different model or keep the same model', () => {
    const saved = { 'grok-4.7': longFast }

    expect(modelForChat(models, ['grok-4.7'], COMPOSER_STANDARD, undefined, saved)).toBe(GROK_LONG_FAST)
    expect(modelForChat(models, ['grok-4.7'], GROK_SHORT_STANDARD, undefined, saved)).toBe(GROK_LONG_FAST)
    expect(modelForChat(models, ['grok-4.7'], COMPOSER_FAST, GROK_SHORT_STANDARD, saved)).toBe(GROK_LONG_FAST)
  })

  it('applies the latest saved parameters to the project and default model for a new chat', () => {
    const saved = { 'grok-4.7': longFast }

    expect(modelForChat(models, [], COMPOSER_STANDARD, GROK_SHORT_STANDARD, saved)).toBe(GROK_LONG_FAST)
    expect(modelForChat(models, [], GROK_SHORT_STANDARD, undefined, saved)).toBe(GROK_LONG_FAST)
    expect(modelForChat(models, [], COMPOSER_STANDARD, COMPOSER_FAST, saved)).toBe(COMPOSER_FAST)
    expect(modelForChat(models, [], 'auto', undefined, saved)).toBe('auto')
  })

  it('falls back to an available variant when saved parameters are no longer supported', () => {
    const saved = { 'grok-4.7': { context: '2M', effort: 'ultra', thinking: true, fast: true } }

    const restored = pickRememberedVariant(group('grok-4.7'), saved)

    expect(restored.id).toBe(GROK_LONG_FAST)
    expect(group('grok-4.7').variants).toContain(restored)
  })

  it('inherits the current parameters for a model that has no saved preference yet', () => {
    expect(pickRememberedVariant(group('composer-2.5'), undefined, findVariant(groups, GROK_LONG_FAST)).id).toBe(COMPOSER_FAST)
    expect(pickRememberedVariant(group('composer-2.5'), {}, findVariant(groups, GROK_SHORT_STANDARD)).id).toBe(COMPOSER_STANDARD)
  })

  it('restores every provider preference after saving and reopening the app state', () => {
    electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-model-preferences-'))
    const diskStore = new Store()
    updateSettings.mockImplementation((patch) => diskStore.updateSettings(patch))
    try {
      rememberModelVariant(GROK_LONG_FAST, undefined, 'cursor')
      rememberModelVariant(GROK_SHORT_STANDARD, undefined, 'codex')
      rememberModelVariant(THINKING_ON, undefined, 'claude')
      diskStore.flush()

      const restored = new Store()
      setState((state) => ({ app: { ...state.app, settings: restored.settings } }))
      const saved = getState().app.settings.modelPreferences
      expect(pickRememberedVariant(group('grok-4.7'), saved.cursor).id).toBe(GROK_LONG_FAST)
      expect(pickRememberedVariant(group('grok-4.7'), saved.codex).id).toBe(GROK_SHORT_STANDARD)
      expect(pickRememberedVariant(group('sonnet'), saved.claude).id).toBe(THINKING_ON)
      restored.flush()
    } finally {
      diskStore.flush()
      const dir = path.resolve(electron.userData)
      if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('agent-desktop-model-preferences-')) {
        throw new Error(`Refusing to remove unexpected test directory: ${dir}`)
      }
      fs.rmSync(dir, { recursive: true, force: true })
      electron.userData = ''
    }
  })
})
