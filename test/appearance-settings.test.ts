import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE, normalizeFontFamily, normalizeFontSize } from '../src/shared/appearance'
import { settingsHandlers } from '../src/main/ipc/settings'
import { Store } from '../src/main/store'
import type { IpcDeps } from '../src/main/ipc/deps'
import type { Settings } from '../src/shared/types'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }))

describe('font preference normalization', () => {
  it('preserves installed font names while trimming and removing control characters', () => {
    expect(normalizeFontFamily('  Microsoft YaHei UI  ')).toBe('Microsoft YaHei UI')
    expect(normalizeFontFamily('思源黑体')).toBe('思源黑体')
    expect(normalizeFontFamily('Fo\u0000nt\n\u0085')).toBe('Font')
    expect(normalizeFontFamily('A'.repeat(101))).toHaveLength(100)
  })

  it.each([undefined, null, 12, {}, []])('uses the system font for a non-string family (%s)', (value) => {
    expect(normalizeFontFamily(value)).toBe('')
  })

  it('clamps font size and rounds to half-pixel increments', () => {
    expect(normalizeFontSize(-50)).toBe(MIN_FONT_SIZE)
    expect(normalizeFontSize(999)).toBe(MAX_FONT_SIZE)
    expect(normalizeFontSize(14.24)).toBe(14)
    expect(normalizeFontSize(14.25)).toBe(14.5)
    expect(normalizeFontSize(13.5)).toBe(13.5)
    expect(normalizeFontSize(Number.MAX_VALUE)).toBe(MAX_FONT_SIZE)
  })

  it.each([undefined, null, NaN, Infinity, -Infinity, '18', {}, []])('uses the default size for non-finite or non-number input (%s)', (value) => {
    expect(normalizeFontSize(value)).toBe(DEFAULT_FONT_SIZE)
  })
})

describe('saved font preferences', () => {
  let store: Store

  beforeEach(() => {
    electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-appearance-'))
    store = new Store()
  })

  afterEach(() => {
    store.flush()
    const dir = path.resolve(electron.userData)
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('agent-desktop-appearance-')) {
      throw new Error(`Unexpected test directory: ${dir}`)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function rewriteSettings(patch: Record<string, unknown>): string {
    store.flush()
    const file = path.join(store.dataDir, 'state.json')
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete state.settings.fontFamily
    delete state.settings.fontSize
    Object.assign(state.settings, patch)
    fs.writeFileSync(file, JSON.stringify(state))
    return file
  }

  function dependencies() {
    return {
      store,
      broadcast: vi.fn(),
      applyRemote: vi.fn(),
      applyTheme: vi.fn(),
      modelsCache: new Map(),
      sessions: { dropIdle: vi.fn() }
    }
  }

  it('migrates old settings to system font and the original size on disk', () => {
    const file = rewriteSettings({})
    store = new Store()
    expect(store.settings).toMatchObject({ fontFamily: '', fontSize: DEFAULT_FONT_SIZE })
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).settings).toMatchObject({ fontFamily: '', fontSize: DEFAULT_FONT_SIZE })
  })

  it('repairs invalid saved values and preserves unrelated preferences', () => {
    const file = rewriteSettings({ fontFamily: 12, fontSize: 'huge', theme: 'dark' })
    store = new Store()
    expect(store.settings).toMatchObject({ fontFamily: '', fontSize: DEFAULT_FONT_SIZE, theme: 'dark' })
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).settings).toMatchObject({ fontFamily: '', fontSize: DEFAULT_FONT_SIZE })
  })

  it('normalizes updates, persists them, and retains the current conversation', async () => {
    const project = store.addProject(electron.userData)
    const thread = store.createThread({ projectId: project.id, title: 'Active conversation', cli: 'cursor', chatId: 'active-session', mode: 'agent', source: 'app' })
    store.setItems(thread.id, [{ id: 'message', kind: 'user', text: 'Keep this conversation', createdAt: 1 }])
    const deps = dependencies()
    const result = await settingsHandlers(deps as unknown as IpcDeps)['settings:update']({ fontFamily: '  思源黑体\n', fontSize: 18.3 }) as Settings
    expect(result).toMatchObject({ fontFamily: '思源黑体', fontSize: 18.5 })
    expect(deps.broadcast).toHaveBeenCalledOnce()
    expect(deps.sessions.dropIdle).not.toHaveBeenCalled()
    expect(deps.applyRemote).not.toHaveBeenCalled()
    expect(deps.applyTheme).not.toHaveBeenCalled()
    store.flush()
    store = new Store()
    expect(store.settings).toMatchObject({ fontFamily: '思源黑体', fontSize: 18.5 })
    expect(store.thread(thread.id)?.chatId).toBe('active-session')
    expect(store.items(thread.id)).toEqual([{ id: 'message', kind: 'user', text: 'Keep this conversation', createdAt: 1 }])
  })

  it('preserves omitted font fields and resets explicitly invalid values', async () => {
    const deps = dependencies()
    const update = settingsHandlers(deps as unknown as IpcDeps)['settings:update']
    await update({ fontFamily: 'Segoe UI', fontSize: 17 })
    await update({ showArchived: true })
    expect(store.settings).toMatchObject({ fontFamily: 'Segoe UI', fontSize: 17, showArchived: true })
    await update({ fontFamily: undefined, fontSize: NaN })
    expect(store.settings).toMatchObject({ fontFamily: '', fontSize: DEFAULT_FONT_SIZE, showArchived: true })
  })
})
