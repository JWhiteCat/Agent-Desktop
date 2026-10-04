import fs from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AppState } from '../src/shared/types'
import { setLanguage } from '../src/shared/i18n'
import App from '../src/renderer/src/App'

const { state } = vi.hoisted(() => ({
  state: {
    app: {} as AppState,
    view: { kind: 'home' } as { kind: 'home' } | { kind: 'thread'; id: string }
  }
}))
vi.mock('../src/renderer/src/store', () => ({
  goHome: vi.fn(),
  useStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
// Isolate App's layout contract; these children retain their real draggable header structure.
vi.mock('../src/renderer/src/components/Home', () => ({
  Home: () => createElement('header', { className: 'main-header drag' }, 'Home header')
}))
vi.mock('../src/renderer/src/components/ThreadView', () => ({
  ThreadView: () => createElement('header', { className: 'main-header drag' }, 'Thread header')
}))
vi.mock('../src/renderer/src/components/Sidebar', () => ({
  Sidebar: () => createElement('aside', { className: 'sidebar' },
    createElement('div', { className: 'sidebar-top drag' }))
}))
vi.mock('../src/renderer/src/components/ChangesPanel', () => ({ ChangesPanel: () => null }))
vi.mock('../src/renderer/src/components/ImportDialog', () => ({ ImportDialog: () => null }))
vi.mock('../src/renderer/src/components/settings/SettingsDialog', () => ({ SettingsDialog: () => null }))

beforeEach(() => {
  setLanguage('en')
  state.app = {
    settings: { ...DEFAULT_SETTINGS }, projects: [], running: [],
    threads: [{ id: 'thread', projectId: 'project', title: 'Example', mode: 'ask', source: 'app', createdAt: 1, updatedAt: 1 }]
  }
})
afterEach(() => {
  setLanguage('system', 'zh-CN')
  vi.unstubAllGlobals()
})

describe('sidebar toggle native hit-test contract', () => {
  it.each([
    ['home', false], ['home', true], ['thread', false], ['thread', true]
  ] as const)('keeps the %s toggle after draggable headers (narrow: %s)', (view, narrow) => {
    state.view = view === 'home' ? { kind: 'home' } : { kind: 'thread', id: 'thread' }
    vi.stubGlobal('window', { matchMedia: () => ({ matches: narrow }) })
    const html = renderToStaticMarkup(createElement(App))
    const toggleIndex = html.indexOf('class="icon-btn sidebar-toggle no-drag"')
    expect(toggleIndex).toBeGreaterThan(html.indexOf('</main>'))
    expect(html.indexOf('class="main-header drag"')).toBeGreaterThan(-1)
    if (!narrow) expect(toggleIndex).toBeGreaterThan(html.indexOf('class="sidebar-top drag"'))
    expect(html).toContain(`aria-expanded="${!narrow}"`)
    expect(html).toContain(`aria-label="${narrow ? 'Show' : 'Hide'} sidebar (Ctrl+B)"`)
    expect(html.includes('class="sidebar"')).toBe(!narrow)
    expect(html.match(/sidebar-toggle/g)).toHaveLength(1)
  })

  it('keeps the narrow close button above the sidebar and scrim, but below dialogs', () => {
    const css = fs.readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    const narrowCss = css.slice(css.indexOf('@media (max-width: 720px)'))
    const layer = (source: string, selector: string): number => {
      const body = source.slice(source.indexOf(`${selector} {`)).split('}')[0]
      return Number(body.match(/z-index:\s*(\d+)/)?.[1])
    }
    const toggle = layer(narrowCss, '.app:not(.sidebar-hidden) .sidebar-toggle')
    expect(toggle).toBeGreaterThan(layer(narrowCss, '.sidebar'))
    expect(toggle).toBeGreaterThan(layer(narrowCss, '.sidebar-scrim'))
    expect(toggle).toBeLessThan(layer(css, '.modal-backdrop'))
  })
})
