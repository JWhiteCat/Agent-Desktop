import fs from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { DEFAULT_SETTINGS, type AppState } from '../src/shared/types'
import { ComposerOptionsButton, ComposerOptionsPanel } from '../src/renderer/src/components/composer/Pickers'
import { Composer } from '../src/renderer/src/components/Composer'

const { state } = vi.hoisted(() => ({
  state: {
    app: {} as AppState,
    models: [{ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon High' }],
    modelsByCli: {
      antigravity: [{ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon High' }]
    }
  }
}))

vi.mock('../src/renderer/src/store', () => ({
  loadModels: vi.fn(),
  rememberModel: vi.fn(),
  rememberModelVariant: vi.fn(),
  useStore: (selector: (value: typeof state) => unknown) => selector(state)
}))

vi.mock('../src/renderer/src/components/CliInstallAction', () => ({
  CliInstallAction: () => null,
  useCliInstallStatus: () => undefined
}))

beforeEach(() => {
  setLanguage('zh-CN')
  state.app = {
    settings: { ...DEFAULT_SETTINGS },
    projects: [],
    threads: [],
    running: []
  }
  vi.stubGlobal('window', {
    api: { platform: 'web' }
  })
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
  })
})

afterEach(() => {
  setLanguage('system', 'zh-CN')
  vi.unstubAllGlobals()
})

describe('mobile compact composer options', () => {
  it('shows the right status indicator dot for permissions, mode, and worktree', () => {
    const base = {
      cli: 'antigravity' as const,
      onCliChange: vi.fn(),
      mode: 'agent' as const,
      onModeChange: vi.fn(),
      force: false,
      onForceChange: vi.fn()
    }

    const defaultHtml = renderToStaticMarkup(createElement(ComposerOptionsButton, base))
    expect(defaultHtml).toContain('class="icon-btn composer-options-btn "')
    expect(defaultHtml).not.toContain('composer-options-dot')
    expect(defaultHtml).toContain('对话选项 · Antigravity · Agent · 默认权限')

    const planHtml = renderToStaticMarkup(createElement(ComposerOptionsButton, { ...base, mode: 'plan' }))
    expect(planHtml).toContain('class="composer-options-dot active"')

    const worktreeHtml = renderToStaticMarkup(
      createElement(ComposerOptionsButton, { ...base, showWorktree: true, worktree: true, onWorktreeChange: vi.fn() })
    )
    expect(worktreeHtml).toContain('class="composer-options-dot active"')
    expect(worktreeHtml).toContain('Worktree')

    const forceHtml = renderToStaticMarkup(createElement(ComposerOptionsButton, { ...base, mode: 'plan', force: true }))
    expect(forceHtml).toContain('class="composer-options-dot warn"')
    expect(forceHtml).toContain('完全访问')
  })

  it('renders CLI, mode, permission, and optional worktree choices inside ComposerOptionsPanel', () => {
    const html = renderToStaticMarkup(
      createElement(ComposerOptionsPanel, {
        cli: 'antigravity',
        cliDisabled: true,
        cliNote: '对话进行中，结束后再切换 CLI',
        onCliChange: vi.fn(),
        mode: 'ask',
        onModeChange: vi.fn(),
        force: true,
        onForceChange: vi.fn(),
        showWorktree: true,
        worktree: true,
        onWorktreeChange: vi.fn()
      })
    )

    expect(html).toContain('>CLI<')
    expect(html).toContain('>Antigravity<')
    expect(html).toContain('对话进行中，结束后再切换 CLI')
    expect(html).toContain('>模式<')
    expect(html).toContain('>Ask<')
    expect(html).toContain('>权限<')
    expect(html).toContain('class="model-opt selected warn"')
    expect(html).toContain('>工作区<')
    expect(html).toContain('>Worktree<')
  })

  it('renders both desktop controls and the compact mobile options button inside Composer', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        projectId: 'p1',
        draftScope: 'thread:t1',
        cli: 'antigravity',
        onCliChange: vi.fn(),
        initial: { model: 'gemini-4-argon-high', mode: 'agent', force: true, cli: 'antigravity' },
        onSend: vi.fn()
      })
    )

    expect(html).toContain('class="composer-desktop-controls"')
    expect(html).toContain('composer-options-btn')
    expect(html).toContain('class="composer-options-dot warn"')
    expect(html).toContain('class="composer-actions"')
  })

  it('enforces the narrow (<= 720px) two-row layout contract in styles.css', () => {
    const css = fs.readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    const narrowCss = css.slice(css.lastIndexOf('@media (max-width: 720px)'))

    expect(css).toMatch(/\.composer-desktop-controls\s*\{\s*display:\s*contents;/)
    expect(css).toMatch(/\.composer-options-btn\s*\{[^}]*display:\s*none;/)

    expect(narrowCss).toMatch(/\.composer\s*\{[^}]*padding:\s*8px 10px 6px 12px;/)
    expect(narrowCss).toMatch(/\.composer-left\s*\{[^}]*flex-wrap:\s*nowrap;/)
    expect(narrowCss).toMatch(/\.composer-desktop-controls\s*\{\s*display:\s*none;/)
    expect(narrowCss).toMatch(/\.composer-options-btn\s*\{[^}]*display:\s*inline-flex;/)
  })
})
