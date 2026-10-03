import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { DEFAULT_SETTINGS, type AppState } from '../src/shared/types'
import { TaskCounts } from '../src/renderer/src/components/TaskCounts'
import { Sidebar } from '../src/renderer/src/components/Sidebar'

const { mockState } = vi.hoisted(() => ({ mockState: { app: {} as AppState, view: { kind: 'home' } } }))
vi.mock('../src/renderer/src/store', () => ({
  addProjectInteractive: vi.fn(), forkThread: vi.fn(), goHome: vi.fn(), openThread: vi.fn(),
  setState: vi.fn(), syncThreadFromCli: vi.fn(), toast: vi.fn(),
  useStore: (selector: (state: typeof mockState) => unknown) => selector(mockState)
}))

afterEach(() => {
  setLanguage('system', 'zh-CN')
  vi.unstubAllGlobals()
})

describe('task count display', () => {
  it.each([
    ['zh-CN', '正在进行', '未读', '任务统计'],
    ['en', 'In progress', 'Unread', 'Task counts']
  ] as const)('shows both zero counts with %s labels', (language, running, unread, accessibleLabel) => {
    setLanguage(language)
    const html = renderToStaticMarkup(createElement(TaskCounts, { counts: { running: 0, unread: 0 } }))
    expect(html).toContain(`aria-label="${accessibleLabel}"`)
    expect(html).toContain(`<span>${running}</span><strong>0</strong>`)
    expect(html).toContain(`<span>${unread}</span><strong>0</strong>`)
    expect(html).toContain('role="status"')
  })

  it('keeps the complete numbers in the sidebar instead of using the taskbar cap', () => {
    setLanguage('zh-CN')
    const html = renderToStaticMarkup(createElement(TaskCounts, { counts: { running: 123, unread: 456 } }))
    expect(html).toContain('<span>正在进行</span><strong>123</strong>')
    expect(html).toContain('<span>未读</span><strong>456</strong>')
    expect(html).not.toContain('99+')
  })

  it('shows global counts above Settings while archived and collapsed conversations are hidden', () => {
    setLanguage('en')
    vi.stubGlobal('window', { api: { platform: 'win32' } })
    mockState.app = {
      projects: [{ id: 'project', name: 'Example', path: '/example', createdAt: 1, collapsed: true }],
      threads: [
        { id: 'running', projectId: 'project', title: 'Hidden running task', mode: 'agent', createdAt: 1, updatedAt: 1, source: 'app', unread: true },
        { id: 'archived', projectId: 'project', title: 'Hidden archived task', mode: 'agent', createdAt: 1, updatedAt: 1, source: 'app', archived: true, unread: true }
      ],
      settings: { ...DEFAULT_SETTINGS, showArchived: false },
      running: ['running']
    }
    const html = renderToStaticMarkup(createElement(Sidebar, { onOpenSettings: vi.fn(), onOpenImport: vi.fn() }))
    expect(html).not.toContain('Hidden running task')
    expect(html).not.toContain('Hidden archived task')
    expect(html).toContain('<div class="sidebar-bottom"><div class="task-counts"')
    expect(html).toContain('<span>In progress</span><strong>1</strong>')
    expect(html).toContain('<span>Unread</span><strong>1</strong>')
    expect(html.indexOf('class="task-counts"')).toBeLessThan(html.indexOf('<span>Settings</span>'))
  })
})
