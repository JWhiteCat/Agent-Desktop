import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { DEFAULT_THREAD_TOOLBAR_BUTTONS } from '../src/shared/toolbar'
import { DEFAULT_SETTINGS, type AppState, type ToolbarButton } from '../src/shared/types'
import { ThreadToolbar, measureToolbarLayout, toolbarVisibleCount } from '../src/renderer/src/components/ThreadToolbar'
import { ToolbarSettings, toolbarArgumentLines } from '../src/renderer/src/components/settings/ToolbarSettings'
import { SettingsDialog } from '../src/renderer/src/components/settings/SettingsDialog'

const { state } = vi.hoisted(() => ({ state: { app: {} as AppState } }))
vi.mock('../src/renderer/src/store', () => ({
  errorText: (error: unknown) => String(error), toast: vi.fn(), loadModels: vi.fn(), setDefaultModel: vi.fn(),
  useStore: (selector: (value: typeof state) => unknown) => selector(state)
}))

const command: ToolbarButton = { id: 'custom', kind: 'command', name: 'Run tests', program: 'npm', args: ['test'], visible: true }
const toolbar = (buttons = DEFAULT_THREAD_TOOLBAR_BUTTONS, canFork = true, changesOpen = false) => renderToStaticMarkup(createElement(ThreadToolbar, {
  buttons, threadId: 'thread', cwd: 'D:/Project worktree', canFork, changesOpen, onFork: vi.fn(), onToggleChanges: vi.fn()
}))

beforeEach(() => {
  setLanguage('zh-CN')
  vi.stubGlobal('window', { api: { isRemote: false } })
  state.app = { settings: { ...DEFAULT_SETTINGS, threadToolbarButtons: DEFAULT_THREAD_TOOLBAR_BUTTONS }, projects: [], threads: [], running: [] }
})
afterEach(() => {
  setLanguage('system', 'zh-CN')
  vi.unstubAllGlobals()
})

describe('conversation toolbar', () => {
  it('ignores unavailable measurements instead of shrinking the toolbar into the Windows caption area', () => {
    expect(measureToolbarLayout([30, 30, 30, 30, 30], 158)).toEqual({ count: 5, width: 158 })
    expect(measureToolbarLayout([0, 0, 0, 0, 0], 158)).toBeNull()
    expect(measureToolbarLayout([30, 30, 30, 30, 30], 0)).toBeNull()
    expect(measureToolbarLayout([30, NaN], 158)).toBeNull()
    expect(measureToolbarLayout([], 158)).toBeNull()
    expect(measureToolbarLayout([30, 30, 30, 30, 30], 95)).toEqual({ count: 1, width: 158 })
  })

  it('renders VS Code immediately before Cursor in the default order', () => {
    const html = toolbar()
    const labels = ['分叉对话（/fork）', '在文件管理器中打开 D:/Project worktree', '在 VS Code 中打开', '在 Cursor 中打开', '变更面板 (Ctrl+Shift+D)']
    const indexes = labels.map((label) => html.indexOf(`title="${label}"`))
    expect(indexes.every((index) => index >= 0)).toBe(true)
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right))
  })

  it('honors hidden actions and custom command ordering, preserves fork disabled and changes active states', () => {
    const buttons = [command, ...DEFAULT_THREAD_TOOLBAR_BUTTONS.map((button) => button.kind === 'builtin' && button.action === 'cursor' ? { ...button, visible: false } : button)]
    const html = toolbar(buttons, false, true)
    expect(html.indexOf('title="Run tests"')).toBeLessThan(html.indexOf('title="分叉对话（/fork）"'))
    expect(html).toContain('thread-toolbar-command')
    expect(html).not.toContain('title="在 Cursor 中打开"')
    expect(html).toMatch(/title="分叉对话（\/fork）"[^>]*disabled=""/)
    expect(html).toMatch(/class="icon-btn thread-toolbar-button  active"[^>]*aria-pressed="true"/)
  })

  it('keeps only fork and changes available to remote clients', () => {
    vi.stubGlobal('window', { api: { isRemote: true } })
    const html = toolbar([...DEFAULT_THREAD_TOOLBAR_BUTTONS, command])
    expect(html).toContain('title="分叉对话（/fork）"')
    expect(html).toContain('title="变更面板 (Ctrl+Shift+D)"')
    expect(html).not.toContain('Run tests')
    expect(html).not.toContain('在 VS Code 中打开')
    expect(html).not.toContain('在 Cursor 中打开')
    expect(html).not.toContain('在文件管理器中打开')
  })

  it('moves the trailing prefix into More without splitting or reordering commands', () => {
    expect(toolbarVisibleCount([30, 30, 30], 94)).toBe(3)
    expect(toolbarVisibleCount([30, 30, 30], 93)).toBe(1)
    expect(toolbarVisibleCount([130, 30, 30], 100)).toBe(0)
    expect(toolbarVisibleCount([30, 130, 30], 100)).toBe(1)
    expect(toolbarVisibleCount([], 0)).toBe(0)
  })
})

describe('toolbar settings', () => {
  it('shows all builtins, visibility controls and command edit/delete controls', () => {
    state.app.settings.threadToolbarButtons = [...DEFAULT_THREAD_TOOLBAR_BUTTONS, command]
    const html = renderToStaticMarkup(createElement(ToolbarSettings))
    expect(html).toContain('aria-label="顶部按钮顺序"')
    expect(html).toContain('aria-label="显示 在 VS Code 中打开"')
    expect(html).toContain('aria-label="上移 分叉对话" disabled=""')
    expect(html).toContain('aria-label="下移 Run tests" disabled=""')
    expect(html).toContain('aria-label="编辑 Run tests"')
    expect(html).toContain('aria-label="删除 Run tests"')
    expect(html).toContain('添加命令按钮')
  })

  it('keeps appearance as the settings category and exposes no standalone toolbar category', () => {
    const props = { onClose: vi.fn(), onOpenImport: vi.fn() }
    const desktop = renderToStaticMarkup(createElement(SettingsDialog, props))
    expect(desktop).toContain('外观与历史')
    expect(desktop).not.toContain('顶部按钮')
    expect(renderToStaticMarkup(createElement(ToolbarSettings))).toContain('顶部按钮')
    vi.stubGlobal('window', { api: { isRemote: true } })
    expect(renderToStaticMarkup(createElement(SettingsDialog, props))).not.toContain('顶部按钮')
    expect(renderToStaticMarkup(createElement(ToolbarSettings))).toBe('')
  })

  it('preserves argument spaces, quotes, Chinese, backslashes and shell metacharacters as literal values', () => {
    const args = '  with leading and trailing spaces  \r\n\r\n   \nD:\\中文 目录\\\n"quoted"\n$(echo test); & | > % !'
    expect(toolbarArgumentLines(args)).toEqual(['  with leading and trailing spaces  ', 'D:\\中文 目录\\', '"quoted"', '$(echo test); & | > % !'])
  })
})
