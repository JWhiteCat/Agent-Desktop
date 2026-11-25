import { useT } from '../lib/i18n'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import type { ThreadMeta } from '@shared/types'
import { displayThreadTitle } from '@shared/thread-title'
import { getTaskCounts } from '@shared/task-counts'
import { addProjectInteractive, collapseAllProjects, goHome, openGrokBot, openNextRunningThread, openNextUnreadThread, useStore } from '../store'
import {
  IconArchive,
  IconBot,
  IconChevronRight,
  IconCompose,
  IconImport,
  IconMore,
  IconPlus,
  IconSearch,
  IconSettings,
  IconX
} from './icons'
import { MenuButton } from './Menu'
import { ResizeHandle } from './ResizeHandle'
import { TaskCounts } from './TaskCounts'
import { ProjectRow } from './sidebar/ProjectRow'
import { ThreadRow } from './sidebar/ThreadRow'

const COLLAPSED_LIMIT = 6

interface Props {
  onOpenSettings: () => void
  onOpenImport: () => void
}

function sortThreads(threads: ThreadMeta[]): ThreadMeta[] {
  return threads.slice().sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
}

export const Sidebar = forwardRef<HTMLInputElement, Props>(function Sidebar({ onOpenSettings, onOpenImport }, searchRef) {
  const t = useT()
  const projects = useStore((s) => s.app.projects)
  const threads = useStore((s) => s.app.threads)
  const running = useStore((s) => s.app.running)
  const waitingForInput = useStore((s) => s.app.waitingForInput)
  const showArchived = useStore((s) => s.app.settings.showArchived)
  const view = useStore((s) => s.view)
  const sidebarReveal = useStore((s) => s.sidebarReveal)
  const taskNavigationPending = useStore((s) => s.taskNavigationPending)
  const activeId = view.kind === 'thread' ? view.id : undefined
  const reveal = sidebarReveal?.threadId === activeId ? sidebarReveal : undefined
  const revealThread = reveal ? threads.find((thread) => thread.id === reveal.threadId) : undefined
  const revealProject = projects.find((project) => project.id === revealThread?.projectId)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [collapsing, setCollapsing] = useState(false)
  const revealedRow = useRef<HTMLDivElement>(null)
  const scrolledReveal = useRef<number | undefined>(undefined)
  const [, tick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!revealThread || !reveal) return
    setQuery('')
  }, [reveal?.token, revealThread?.projectId])

  useEffect(() => {
    if (!reveal || query.trim() || scrolledReveal.current === reveal.token || !revealedRow.current) return
    revealedRow.current.scrollIntoView({ block: 'nearest' })
    scrolledReveal.current = reveal.token
  }, [reveal?.token, revealProject?.collapsed, expanded, query])

  const runningSet = useMemo(() => new Set(running), [running])
  const taskCounts = useMemo(() => getTaskCounts({ threads, running, waitingForInput }), [threads, running, waitingForInput])
  const visible = useMemo(
    () => threads.filter((thread) => showArchived || !thread.archived || thread.id === revealThread?.id),
    [threads, showArchived, revealThread?.id]
  )

  const byProject = useMemo(() => {
    const m = new Map<string, ThreadMeta[]>()
    for (const thread of visible) {
      const arr = m.get(thread.projectId) ?? []
      arr.push(thread)
      m.set(thread.projectId, arr)
    }
    for (const [k, v] of m) m.set(k, sortThreads(v))
    return m
  }, [visible])

  const totalCountByProject = useMemo(() => {
    const m = new Map<string, number>()
    for (const thread of threads) {
      m.set(thread.projectId, (m.get(thread.projectId) ?? 0) + 1)
    }
    return m
  }, [threads])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const projectName = new Map(projects.map((p) => [p.id, p.name]))
    return sortThreads(threads).filter(
      (thread) =>
        displayThreadTitle(thread, t).toLowerCase().includes(q) ||
        (thread.preview ?? '').toLowerCase().includes(q) ||
        (projectName.get(thread.projectId) ?? '').toLowerCase().includes(q)
    )
  }, [query, threads, projects, t])

  const renderThread = (thread: ThreadMeta, showProject?: string) => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      active={thread.id === activeId}
      running={runningSet.has(thread.id)}
      editing={editing === thread.id}
      projectName={showProject}
      rowRef={thread.id === revealThread?.id ? revealedRow : undefined}
      onEdit={() => setEditing(thread.id)}
      onEditDone={() => setEditing(null)}
    />
  )

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag" />
      <div className="sidebar-actions">
        <button className="nav-btn" onClick={() => goHome()}>
          <IconCompose />
          <span>{t('新对话')}</span>
          <kbd>{window.api.platform === 'darwin' ? '⌘N' : 'Ctrl+N'}</kbd>
        </button>
        <div className="search-box">
          <IconSearch size={14} />
          <input
            ref={searchRef}
            value={query}
            placeholder={t('搜索对话')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          />
          {query && (
            <button className="icon-btn tiny" title={t('清空搜索')} onClick={() => setQuery('')}>
              <IconX size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="sidebar-scroll">
        {!results && (
          <button className={`nav-btn grokbot-entry ${view.kind === 'grokbot' ? 'active' : ''}`} onClick={() => openGrokBot()}>
            <IconBot />
            <span>Grok Bot</span>
          </button>
        )}
        {results ? (
          <div className="section">
            <div className="section-title">
              <span>{t('搜索结果 · {count}', { count: results.length })}</span>
            </div>
            {results.length === 0 && <div className="empty-hint">{t('没有匹配的对话')}</div>}
            {results.map((thread) => renderThread(thread, projects.find((p) => p.id === thread.projectId)?.name))}
          </div>
        ) : (
          <div className="section">
            <div className="section-title">
              <span>{t('项目')}</span>
              <div className="section-tools">
                <button
                  type="button"
                  className="icon-btn tiny"
                  title={t('全部折叠')}
                  aria-label={t('全部折叠')}
                  disabled={collapsing || taskNavigationPending || projects.every((project) => project.collapsed)}
                  onClick={() => {
                    setCollapsing(true)
                    void collapseAllProjects().finally(() => setCollapsing(false))
                  }}
                >
                  <IconChevronRight size={14} />
                </button>
                <MenuButton
                  className="icon-btn tiny"
                  title={t('更多')}
                  placement="bottom-end"
                  items={[
                    { label: t('导入 Cursor CLI 历史会话…'), icon: <IconImport size={14} />, onSelect: onOpenImport },
                    {
                      label: t('显示已归档对话'),
                      icon: <IconArchive size={14} />,
                      checked: showArchived,
                      onSelect: () => window.api.updateSettings({ showArchived: !showArchived })
                    }
                  ]}
                >
                  <IconMore size={14} />
                </MenuButton>
                <button className="icon-btn tiny" title={t('添加项目')} onClick={() => addProjectInteractive().then((id) => id && goHome(id))}>
                  <IconPlus size={14} />
                </button>
              </div>
            </div>
            {projects.length === 0 && (
              <div className="empty-hint">
                {t('还没有项目。')}
                <button className="link-btn" onClick={() => addProjectInteractive().then((id) => id && goHome(id))}>
                  {t('添加项目文件夹')}
                </button>
                <span> {t('或')} </span>
                <button className="link-btn" onClick={onOpenImport}>
                  {t('导入 CLI 历史')}
                </button>
              </div>
            )}
            {projects.map((p, i) => {
              const list = byProject.get(p.id) ?? []
              const isExpanded = expanded[p.id]
              const shown = isExpanded ? list : list.slice(0, COLLAPSED_LIMIT)
              if (!isExpanded && revealThread?.projectId === p.id && !shown.includes(revealThread)) shown.push(revealThread)
              const anyRunning = list.some((thread) => runningSet.has(thread.id))
              return (
                <div key={p.id} className="project">
                  <ProjectRow
                    project={p}
                    index={i}
                    total={projects.length}
                    count={totalCountByProject.get(p.id) ?? 0}
                    running={anyRunning}
                    editing={editing === p.id}
                    onEdit={() => setEditing(p.id)}
                    onEditDone={() => setEditing(null)}
                  />
                  {!p.collapsed && (
                    <div className="project-threads">
                      {list.length === 0 && <div className="empty-hint small">{t('暂无对话')}</div>}
                      {shown.map((thread) => renderThread(thread))}
                      {(isExpanded ? list.length > COLLAPSED_LIMIT : list.length > shown.length) && (
                        <button className="show-more" onClick={() => setExpanded((e) => ({ ...e, [p.id]: !isExpanded }))}>
                          {isExpanded ? t('收起') : t('显示更多（{count}）', { count: list.length - shown.length })}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="sidebar-bottom">
        <TaskCounts
          counts={taskCounts}
          onOpenRunning={() => void openNextRunningThread()}
          onOpenUnread={() => void openNextUnreadThread()}
          navigationPending={taskNavigationPending || collapsing}
        />
        <button className="nav-btn" onClick={onOpenSettings}>
          <IconSettings />
          <span>{t('设置')}</span>
        </button>
      </div>
      <ResizeHandle panel="sidebar" label={t('调整侧边栏宽度')} />
    </aside>
  )
})
