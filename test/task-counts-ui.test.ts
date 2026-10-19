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
  sidebarReveal: undefined as { threadId: string; token: number } | undefined,
  taskNavigationPending: false
} }))
vi.mock('../src/renderer/src/store', () => ({
  addProjectInteractive: vi.fn(), collapseAllProjects: vi.fn(), forkThread: vi.fn(), goHome: vi.fn(), openGrokBot: vi.fn(), openNextRunningThread: vi.fn(), openNextUnreadThread: vi.fn(), openThread: vi.fn(),
  setState: vi.fn(), syncThreadFromCli: vi.fn(), toast: vi.fn(),
  useStore: (selector: (state: typeof mockState) => unknown) => selector(mockState)
}))

afterEach(() => {
  setLanguage('system', 'zh-CN')
  vi.unstubAllGlobals()
  mockState.view = { kind: 'home' }
  mockState.sidebarReveal = undefined
  mockState.taskNavigationPending = false
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

  it.each([
    ['zh-CN', '跳转到下一个正在进行的会话（2）', '跳转到下一个未读会话（2）'],
    ['en', 'Go to the next in-progress conversation (2)', 'Go to the next unread conversation (2)']
  ] as const)('offers accessible jump buttons with %s labels and disables them for zero or pending navigation', (language, runningLabel, unreadLabel) => {
    setLanguage(language)
    const render = (count: number, navigationPending = false) => renderToStaticMarkup(createElement(TaskCounts, {
      counts: { running: count, unread: count }, onOpenRunning: vi.fn(), onOpenUnread: vi.fn(), navigationPending
    }))
    expect(render(2)).toContain(`aria-label="${runningLabel}"`)
    expect(render(2)).toContain(`aria-label="${unreadLabel}"`)
    expect(render(2)).not.toContain('disabled=""')
    expect(render(0).match(/disabled=""/g)).toHaveLength(2)
    expect(render(2, true).match(/disabled=""/g)).toHaveLength(2)
    expect(render(2, true).match(/aria-busy="true"/g)).toHaveLength(2)
  })

  it('shows a waiting unread dot before the running spinner and clears it after viewing', () => {
    setLanguage('en')
    vi.stubGlobal('window', { api: { platform: 'win32' } })
    mockState.app = {
      projects: [{ id: 'project', name: 'Example', path: '/example', createdAt: 1 }],
      threads: [{ id: 'waiting', projectId: 'project', title: 'Waiting task', mode: 'agent', source: 'app', createdAt: 1, updatedAt: 1, unread: true }],
      settings: { ...DEFAULT_SETTINGS }, running: ['waiting'], waitingForInput: ['waiting']
    }
    const render = () => renderToStaticMarkup(createElement(Sidebar, { onOpenSettings: vi.fn(), onOpenImport: vi.fn() }))
    const unread = render()
    expect(unread).toContain('<span class="thread-status"><span class="unread-dot"')
    expect(unread).toContain('<span>In progress</span><strong>1</strong>')
    expect(unread).toContain('<span>Unread</span><strong>1</strong>')
    mockState.app.threads[0] = { ...mockState.app.threads[0], unread: false }
    const read = render()
    expect(read).not.toContain('unread-dot')
    expect(read).toContain('<span>Unread</span><strong>0</strong>')
    expect(read).toContain('<span>In progress</span><strong>1</strong>')
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
    expect(html.match(/disabled=""/g)).toHaveLength(1)

    mockState.taskNavigationPending = true
    const pendingHtml = renderToStaticMarkup(createElement(Sidebar, { onOpenSettings: vi.fn(), onOpenImport: vi.fn() }))
    expect(pendingHtml.match(/aria-busy="true"/g)).toHaveLength(2)
    expect(pendingHtml.match(/disabled=""/g)).toHaveLength(3)
  })

  it.each([false, true])('reveals an archived target beyond six rows after remounting (running: %s)', (running) => {
    vi.stubGlobal('window', { api: { platform: 'win32' } })
    const target = { id: 'target', projectId: 'project', title: 'Archived unread target', mode: 'agent' as const, source: 'app' as const, createdAt: 1, updatedAt: 0, unread: true, archived: true }
    mockState.app = {
      projects: [{ id: 'project', name: 'Example', path: '/example', createdAt: 1 }],
      threads: [
        ...Array.from({ length: 7 }, (_, index) => ({ ...target, id: `newer-${index}`, title: `Newer ${index}`, archived: false, unread: false, updatedAt: index + 1 })),
        target,
        { ...target, id: 'other-archived', title: 'Other archived target' }
      ],
      settings: { ...DEFAULT_SETTINGS, showArchived: false }, running: running ? [target.id] : []
    }
    mockState.view = { kind: 'thread', id: target.id }
    mockState.sidebarReveal = { threadId: target.id, token: 1 }

    const html = renderToStaticMarkup(createElement(Sidebar, { onOpenSettings: vi.fn(), onOpenImport: vi.fn() }))

    expect(html).toContain('Archived unread target')
    expect(html).not.toContain('Other archived target')
    expect(html).not.toContain('Newer 0')
    expect(html).toContain('Newer 1')
    expect(html).toContain('Newer 6')
    expect(html).toContain('显示更多（1）')
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
