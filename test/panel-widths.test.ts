import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAIN_MIN_WIDTH,
  PANEL_LIMITS,
  clampPanelWidth,
  defaultPanelWidths,
  fitPanelWidths,
  normalizePanelWidths,
  panelDragMax,
  resolvePanelWidths,
  type PanelWidths
} from '../src/shared/panel-widths'
import { PANEL_WIDTHS_KEY, PanelLayout, readStoredPanelWidths, savePanelWidths, writeStoredPanelWidths } from '../src/renderer/src/lib/panel-layout'
import { ResizeHandle } from '../src/renderer/src/components/ResizeHandle'
import { handlersForRemote } from '../src/main/remote-runtime'
import { settingsHandlers } from '../src/main/ipc/settings'
import { Store } from '../src/main/store'
import type { IpcDeps } from '../src/main/ipc/deps'
import { DEFAULT_SETTINGS, type AppState, type Settings } from '../src/shared/types'
import { setLanguage } from '../src/shared/i18n'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }))

const widths = (sidebar: number, changes: number, grokbotList: number): PanelWidths => ({ sidebar, changes, grokbotList })

describe('panel width limits', () => {
  it('clamps to whole pixels within each panel limit', () => {
    expect(clampPanelWidth('sidebar', 150)).toBe(200)
    expect(clampPanelWidth('sidebar', 900)).toBe(480)
    expect(clampPanelWidth('sidebar', 300.6)).toBe(301)
    expect(clampPanelWidth('changes', 200)).toBe(320)
    expect(clampPanelWidth('changes', 5000)).toBe(1000)
    expect(clampPanelWidth('grokbotList', 0)).toBe(180)
    expect(clampPanelWidth('grokbotList', '300')).toBe(300)
  })

  it.each([undefined, null, NaN, Infinity, '', 'wide', {}])('uses the default for %s', (value) => {
    expect(clampPanelWidth('sidebar', value)).toBe(PANEL_LIMITS.sidebar.default)
  })

  it('keeps only known panels with finite numeric widths', () => {
    expect(normalizePanelWidths({ sidebar: 100, changes: '600', grokbotList: 300.2, other: 300, toString: 5 })).toEqual({ sidebar: 200, grokbotList: 300 })
    expect(normalizePanelWidths([300])).toEqual({})
    expect(normalizePanelWidths('x')).toEqual({})
    expect(normalizePanelWidths(null)).toEqual({})
    expect(resolvePanelWidths({ changes: 700 })).toEqual(widths(272, 700, 240))
  })

  it('leaves preferred widths alone when the window has room', () => {
    expect(fitPanelWidths(widths(300, 500, 240), ['sidebar', 'changes'], 1600)).toEqual(widths(300, 500, 240))
  })

  it('shrinks the changes panel, then the Grok Bot list, then the sidebar, to keep the main area', () => {
    // 272 + 460 + 320 = 1052 needs 152 pixels in a 900-pixel window: 140 from the changes panel, 12 from the sidebar.
    expect(fitPanelWidths(defaultPanelWidths(), ['sidebar', 'changes'], 900)).toEqual(widths(260, 320, 240))
    const fitted = fitPanelWidths(defaultPanelWidths(), ['sidebar', 'changes'], 900)
    expect(fitted.changes).toBe(PANEL_LIMITS.changes.min)
    expect(fitted.sidebar).toBe(900 - MAIN_MIN_WIDTH - PANEL_LIMITS.changes.min)
    expect(fitPanelWidths(widths(400, 460, 400), ['sidebar', 'grokbotList'], 1000)).toEqual(widths(400, 460, 280))
    expect(fitPanelWidths(widths(400, 460, 400), ['sidebar', 'grokbotList'], 600)).toEqual(widths(200, 460, 180))
  })

  it('shrinks the panel being resized last', () => {
    expect(fitPanelWidths(widths(400, 460, 240), ['sidebar', 'changes'], 1100, 'changes')).toEqual(widths(320, 460, 240))
    expect(fitPanelWidths(widths(400, 460, 240), ['sidebar', 'changes'], 1100)).toEqual(widths(400, 380, 240))
  })

  it('ignores closed panels and bad window sizes', () => {
    expect(fitPanelWidths(widths(480, 1000, 400), ['sidebar'], 900)).toEqual(widths(480, 1000, 400))
    expect(fitPanelWidths(widths(480, 1000, 400), ['sidebar', 'changes'], 0)).toEqual(widths(480, 1000, 400))
  })

  it('limits a drag to the space the other open panels leave', () => {
    expect(panelDragMax('sidebar', widths(272, 460, 240), ['sidebar', 'changes'], 1200)).toBe(1200 - MAIN_MIN_WIDTH - 460)
    expect(panelDragMax('sidebar', widths(272, 460, 240), ['sidebar'], 2000)).toBe(480)
    expect(panelDragMax('changes', widths(272, 460, 240), ['sidebar', 'changes'], 800)).toBe(320)
  })
})

function fakeLayout(viewport = 1400) {
  const vars = new Map<string, string>()
  const saved: PanelWidths[] = []
  const env = { width: viewport }
  const layout = new PanelLayout({ viewport: () => env.width, setVar: (name, value) => vars.set(name, value), save: (w) => saved.push(w) })
  return { layout, vars, saved, env }
}

describe('panel layout', () => {
  it('writes CSS variables for saved widths', () => {
    const { layout, vars } = fakeLayout()
    layout.load({ sidebar: 320, grokbotList: 9999 })
    expect(vars.get('--sidebar-w')).toBe('320px')
    expect(vars.get('--changes-w')).toBe('460px')
    expect(vars.get('--grokbot-list-w')).toBe('400px')
  })

  it('fits open panels to the window and restores preferred widths when it grows', () => {
    const { layout, vars, env } = fakeLayout(1400)
    layout.load({ sidebar: 300, changes: 700 })
    layout.show('sidebar')
    layout.show('changes')
    expect(vars.get('--changes-w')).toBe('700px')
    env.width = 1000
    layout.apply()
    expect(vars.get('--changes-w')).toBe('380px')
    expect(layout.preferred().changes).toBe(700)
    env.width = 1400
    layout.apply()
    expect(vars.get('--changes-w')).toBe('700px')
    layout.hide('changes')
    expect(layout.openPanels()).toEqual(['sidebar'])
  })

  it('keeps the resized panel only while resizing; a smaller window shrinks the changes panel first', () => {
    const { layout, env } = fakeLayout(1400)
    layout.load({ sidebar: 352 })
    layout.show('sidebar')
    layout.show('changes')
    expect(layout.resize('changes', 728)).toBe(728)
    env.width = 900
    expect(layout.apply()).toMatchObject({ sidebar: 260, changes: 320 })
  })

  it('resizes within the free space and saves only when a drag changed something', () => {
    const { layout, vars, saved } = fakeLayout(1200)
    layout.load({})
    layout.show('sidebar')
    layout.show('changes')
    const start = layout.beginDrag('sidebar')
    expect(start).toBe(272)
    expect(layout.resize('sidebar', 1000)).toBe(1200 - MAIN_MIN_WIDTH - 460)
    expect(vars.get('--sidebar-w')).toBe('420px')
    layout.load({ sidebar: 272 })
    expect(layout.width('sidebar')).toBe(420)
    layout.endDrag()
    expect(saved).toEqual([widths(420, 460, 240)])
    layout.beginDrag('sidebar')
    layout.endDrag(false)
    expect(saved).toHaveLength(1)
    expect(layout.resize('sidebar', 10)).toBe(200)
  })

  it('ignores saved widths that arrive before a resize is saved', () => {
    const { layout } = fakeLayout()
    layout.load({})
    layout.show('sidebar')
    layout.resize('sidebar', 300)
    layout.load({ sidebar: 280 })
    expect(layout.width('sidebar')).toBe(300)
    layout.save()
    layout.load({ sidebar: 300 })
    layout.load({ sidebar: 320 })
    expect(layout.width('sidebar')).toBe(320)
    layout.beginDrag('sidebar')
    layout.resize('sidebar', 320)
    layout.endDrag(false)
    layout.load({ sidebar: 330 })
    expect(layout.width('sidebar')).toBe(330)
  })

  it('resets to the default width and saves', () => {
    const { layout, saved, vars } = fakeLayout()
    layout.load({ grokbotList: 380 })
    layout.show('grokbotList')
    expect(layout.reset('grokbotList')).toBe(240)
    expect(vars.get('--grokbot-list-w')).toBe('240px')
    expect(saved.at(-1)?.grokbotList).toBe(240)
  })

  it('counts a panel as open until every handle for it is gone', () => {
    const { layout } = fakeLayout()
    layout.show('sidebar')
    layout.show('sidebar')
    layout.hide('sidebar')
    expect(layout.openPanels()).toEqual(['sidebar'])
    layout.hide('sidebar')
    expect(layout.openPanels()).toEqual([])
  })

  it('notifies subscribers until they unsubscribe', () => {
    const { layout } = fakeLayout()
    const listener = vi.fn()
    const off = layout.subscribe(listener)
    layout.apply()
    off()
    layout.apply()
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('panel width storage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads and writes browser storage for the web client', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    writeStoredPanelWidths(widths(1, 700, 300), storage)
    expect(JSON.parse(data.get(PANEL_WIDTHS_KEY)!)).toEqual(widths(200, 700, 300))
    expect(readStoredPanelWidths(storage)).toEqual(widths(200, 700, 300))
    data.set(PANEL_WIDTHS_KEY, '{bad')
    expect(readStoredPanelWidths(storage)).toEqual({})
    expect(readStoredPanelWidths(undefined)).toEqual({})
    expect(() => writeStoredPanelWidths(widths(300, 400, 200), { setItem: () => { throw new Error('quota') } })).not.toThrow()
  })

  it('saves to settings on the desktop and to browser storage in the web client', async () => {
    const updateSettings = vi.fn().mockResolvedValue({})
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) })
    vi.stubGlobal('window', { api: { platform: 'win32', updateSettings } })
    savePanelWidths(widths(300, 500, 260))
    expect(updateSettings).toHaveBeenCalledWith({ panelWidths: widths(300, 500, 260) })
    expect(data.size).toBe(0)
    vi.stubGlobal('window', { api: { platform: 'web', updateSettings } })
    savePanelWidths(widths(310, 500, 260))
    expect(updateSettings).toHaveBeenCalledOnce()
    expect(JSON.parse(data.get(PANEL_WIDTHS_KEY)!)).toEqual(widths(310, 500, 260))
  })
})

describe('saved panel widths in settings', () => {
  let store: Store

  beforeEach(() => {
    electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-panel-widths-'))
    store = new Store()
  })

  afterEach(() => {
    store.flush()
    const dir = path.resolve(electron.userData)
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('agent-desktop-panel-widths-')) {
      throw new Error(`Unexpected test directory: ${dir}`)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('normalizes updates and keeps them after a restart', async () => {
    const deps = { store, applyRemote: vi.fn(), applyTheme: vi.fn(), broadcast: vi.fn(), modelsCache: new Map(), sessions: { dropIdle: vi.fn() } } as unknown as IpcDeps
    const result = (await settingsHandlers(deps)['settings:update']({ panelWidths: { sidebar: 50, changes: 640, bogus: 1 } as never })) as Settings
    expect(result.panelWidths).toEqual({ sidebar: 200, changes: 640 })
    store.flush()
    store = new Store()
    expect(store.settings.panelWidths).toEqual({ sidebar: 200, changes: 640 })
  })

  it('drops invalid saved widths when loading', () => {
    store.flush()
    const file = path.join(electron.userData, 'data', 'state.json')
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    state.settings.panelWidths = { sidebar: 'wide', grokbotList: 1000 }
    fs.writeFileSync(file, JSON.stringify(state))
    store = new Store()
    expect(store.settings.panelWidths).toEqual({ grokbotList: 400 })
  })

  it('does not let the remote web client change the desktop widths', async () => {
    const update = vi.fn(async (patch: Partial<Settings>) => ({ ...DEFAULT_SETTINGS, ...patch }))
    const remote = handlersForRemote({ 'settings:update': update }, () => ({ settings: DEFAULT_SETTINGS }) as AppState)
    await remote['settings:update']({ panelWidths: { sidebar: 400 }, theme: 'dark' })
    expect(update).toHaveBeenCalledWith({ theme: 'dark' })
  })
})

describe('resize handle markup', () => {
  beforeEach(() => setLanguage('en'))
  afterEach(() => setLanguage('system', 'zh-CN'))

  it('is a keyboard-focusable vertical separator with the current width', () => {
    vi.stubGlobal('window', { innerWidth: 1600 })
    vi.stubGlobal('document', { documentElement: { style: { setProperty: () => {} } } })
    const html = renderToStaticMarkup(createElement(ResizeHandle, { panel: 'changes', label: 'Resize changes panel' }))
    vi.unstubAllGlobals()
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain('aria-label="Resize changes panel"')
    expect(html).toContain('aria-valuenow="460"')
    expect(html).toContain('aria-valuemin="320"')
    expect(html).toContain('aria-valuemax="1000"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('class="resize-handle no-drag edge-left"')
    expect(html).toContain('title="Drag to resize. Double-click to restore the default width."')
  })
})
