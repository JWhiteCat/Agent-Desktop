import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { DEFAULT_SETTINGS, type AppState } from '../src/shared/types'
import { TaskCounts } from '../src/renderer/src/components/TaskCounts'
import { Sidebar } from '../src/renderer/src/components/Sidebar'

const { mockState } = vi.hoisted(() => ({ mockState: {
  app: {} as AppState,
  view: { kind: 'home' } as { kind: 'home' } | { kind: 'thread'; id: string },
  sidebarReveal: undefined as { threadId: string; token: number } | undefined
} }))
vi.mock('../src/renderer/src/store', () => ({
  addProjectInteractive: vi.fn(), collapseAllProjects: vi.fn(), forkThread: vi.fn(), goHome: vi.fn(), openGrokBot: vi.fn(), openNextUnreadThread: vi.fn(), openThread: vi.fn(),
  setState: vi.fn(), syncThreadFromCli: vi.fn(), toast: vi.fn(),
  useStore: (selector: (state: typeof mockState) => unknown) => selector(mockState)
}))

afterEach(() => {
  setLanguage('system', 'zh-CN')
  vi.unstubAllGlobals()
  mockState.view = { kind: 'home' }
  mockState.sidebarReveal = undefined
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

  it('offers an accessible unread jump button and disables it for zero or pending navigation', () => {
    setLanguage('en')
    const render = (unread: number, unreadPending = false) => renderToStaticMarkup(createElement(TaskCounts, {
      counts: { running: 0, unread }, onOpenUnread: vi.fn(), unreadPending
    }))
    expect(render(2)).toContain('aria-label="Go to the next unread conversation (2)"')
    expect(render(2)).not.toContain('disabled=""')
    expect(render(0)).toContain('disabled=""')
    expect(render(2, true)).toContain('disabled=""')
    expect(render(2, true)).toContain('aria-busy="true"')
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

  it('reveals the selected archived conversation beyond six rows after the sidebar remounts', () => {
    vi.stubGlobal('window', { api: { platform: 'win32' } })
    const target = { id: 'target', projectId: 'project', title: 'Archived unread target', mode: 'agent' as const, source: 'app' as const, createdAt: 1, updatedAt: 0, unread: true, archived: true }
    mockState.app = {
      projects: [{ id: 'project', name: 'Example', path: '/example', createdAt: 1 }],
      threads: [
        ...Array.from({ length: 7 }, (_, index) => ({ ...target, id: `newer-${index}`, title: `Newer ${index}`, archived: false, unread: false, updatedAt: index + 1 })),
        target,
        { ...target, id: 'other-archived', title: 'Other archived target' }
      ],
      settings: { ...DEFAULT_SETTINGS, showArchived: false }, running: []
    }
    mockState.view = { kind: 'thread', id: target.id }
    mockState.sidebarReveal = { threadId: target.id, token: 1 }

    const html = renderToStaticMarkup(createElement(Sidebar, { onOpenSettings: vi.fn(), onOpenImport: vi.fn() }))

    expect(html).toContain('Archived unread target')
    expect(html).not.toContain('Other archived target')
    expect(html).toContain('Newer 0')
    expect(html).toContain('Newer 6')
    expect(html).toContain('aria-label="全部折叠"')

    mockState.app = { ...mockState.app, projects: [{ ...mockState.app.projects[0], collapsed: true }] }
    const collapsedHtml = renderToStaticMarkup(createElement(Sidebar, { onOpenSettings: vi.fn(), onOpenImport: vi.fn() }))
    expect(collapsedHtml).not.toContain('Archived unread target')

    mockState.app = { ...mockState.app, projects: [{ ...mockState.app.projects[0], collapsed: false }] }
    mockState.view = { kind: 'home' }
    const homeHtml = renderToStaticMarkup(createElement(Sidebar, { onOpenSettings: vi.fn(), onOpenImport: vi.fn() }))
    expect(homeHtml).not.toContain('Archived unread target')
  })
})
