import { useT } from '../lib/i18n'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, ThreadMeta } from '@shared/types'
import { cliTitle, threadCli } from '@shared/types'
import { displayThreadTitle } from '@shared/thread-title'
import { getTaskCounts } from '@shared/task-counts'
import { relativeTime } from '../lib/format'
import { addProjectInteractive, forkThread, goHome, openThread, setState, syncThreadFromCli, toast, useStore } from '../store'
import {
  IconArchive,
  IconBranch,
  IconChevronDown,
  IconChevronRight,
  IconCompose,
  IconCopy,
  IconCursor,
  IconEdit,
  IconFolder,
  IconImport,
  IconMore,
  IconPin,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconTrash,
  IconX,
  Spinner
} from './icons'
import { MenuButton, type MenuEntry } from './Menu'
import { TaskCounts } from './TaskCounts'

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
  const showArchived = useStore((s) => s.app.settings.showArchived)
  const view = useStore((s) => s.view)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [, tick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  const runningSet = useMemo(() => new Set(running), [running])
  const taskCounts = useMemo(() => getTaskCounts({ threads, running }), [threads, running])
  const activeId = view.kind === 'thread' ? view.id : undefined
  const visible = useMemo(() => threads.filter((t) => showArchived || !t.archived), [threads, showArchived])

  const byProject = useMemo(() => {
    const m = new Map<string, ThreadMeta[]>()
    for (const t of visible) {
      const arr = m.get(t.projectId) ?? []
      arr.push(t)
      m.set(t.projectId, arr)
    }
    for (const [k, v] of m) m.set(k, sortThreads(v))
    return m
  }, [visible])

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

  const renderThread = (t: ThreadMeta, showProject?: string) => (
    <ThreadRow
      key={t.id}
      thread={t}
      active={t.id === activeId}
      running={runningSet.has(t.id)}
      editing={editing === t.id}
      projectName={showProject}
      onEdit={() => setEditing(t.id)}
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
        {results ? (
          <div className="section">
            <div className="section-title">
              <span>{t('搜索结果 · {count}', { count: results.length })}</span>
            </div>
            {results.length === 0 && <div className="empty-hint">{t('没有匹配的对话')}</div>}
            {results.map((t) => renderThread(t, projects.find((p) => p.id === t.projectId)?.name))}
          </div>
        ) : (
          <div className="section">
            <div className="section-title">
              <span>{t('项目')}</span>
              <div className="section-tools">
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
              const anyRunning = list.some((t) => runningSet.has(t.id))
              return (
                <div key={p.id} className="project">
                  <ProjectRow
                    project={p}
                    index={i}
                    total={projects.length}
                    count={list.length}
                    running={anyRunning}
                    editing={editing === p.id}
                    onEdit={() => setEditing(p.id)}
                    onEditDone={() => setEditing(null)}
                  />
                  {!p.collapsed && (
                    <div className="project-threads">
                      {list.length === 0 && <div className="empty-hint small">{t('暂无对话')}</div>}
                      {shown.map((t) => renderThread(t))}
                      {list.length > COLLAPSED_LIMIT && (
                        <button className="show-more" onClick={() => setExpanded((e) => ({ ...e, [p.id]: !isExpanded }))}>
                          {isExpanded ? t('收起') : t('显示更多（{count}）', { count: list.length - COLLAPSED_LIMIT })}
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
        <TaskCounts counts={taskCounts} />
        <button className="nav-btn" onClick={onOpenSettings}>
          <IconSettings />
          <span>{t('设置')}</span>
        </button>
      </div>
    </aside>
  )
})

function InlineRename({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      className="inline-rename"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(text.trim() && text.trim() !== value ? text.trim() : null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setText(value)
          onDone(null)
        }
      }}
    />
  )
}

function ProjectRow(props: {
  project: Project
  index: number
  total: number
  count: number
  running: boolean
  editing: boolean
  onEdit: () => void
  onEditDone: () => void
}) {
  const t = useT()
  const { project: p, index, total, editing } = props
  const projects = useStore((s) => s.app.projects)
  const move = (delta: number) => {
    const ids = projects.map((x) => x.id)
    const j = index + delta
    ;[ids[index], ids[j]] = [ids[j], ids[index]]
    window.api.reorderProjects(ids)
  }
  const menu: MenuEntry[] = [
    { label: t('新对话'), icon: <IconCompose size={14} />, onSelect: () => goHome(p.id) },
    ...(window.api.isRemote
      ? []
      : [
          { label: t('在 Cursor 中打开'), icon: <IconCursor size={14} />, onSelect: () => window.api.openInEditor(p.path) },
          { label: t('在文件管理器中打开'), icon: <IconFolder size={14} />, onSelect: () => window.api.openPath(p.path) }
        ]),
    { label: t('重命名'), icon: <IconEdit size={14} />, onSelect: props.onEdit },
    'separator',
    { label: t('上移'), disabled: index === 0, onSelect: () => move(-1) },
    { label: t('下移'), disabled: index === total - 1, onSelect: () => move(1) },
    'separator',
    {
      label: t('移除项目'),
      icon: <IconTrash size={14} />,
      danger: true,
      onSelect: () => {
        if (confirm(t('移除项目「{name}」？\n该项目下的 {count} 个对话记录也会从本应用中删除（不会删除磁盘上的文件）。', { name: p.name, count: props.count }))) {
          window.api.removeProject(p.id)
          setState((s) => (s.view.kind === 'home' && s.view.projectId === p.id ? { view: { kind: 'home' } } : {}))
        }
      }
    }
  ]
  return (
    <div
      className="project-row"
      title={p.path}
      onClick={() => window.api.updateProject(p.id, { collapsed: !p.collapsed })}
    >
      <span className="chev">{p.collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}</span>
      <IconFolder size={15} />
      {editing ? (
        <InlineRename
          value={p.name}
          onDone={(v) => {
            if (v) window.api.updateProject(p.id, { name: v })
            props.onEditDone()
          }}
        />
      ) : (
        <span className="project-name">{p.name}</span>
      )}
      {props.running && p.collapsed && <Spinner size={11} />}
      <div className="row-tools" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn tiny" title={t('在此项目中新建对话')} onClick={() => goHome(p.id)}>
          <IconCompose size={13} />
        </button>
        <MenuButton className="icon-btn tiny" items={menu} placement="bottom-end" title={t('项目操作')}>
          <IconMore size={14} />
        </MenuButton>
      </div>
    </div>
  )
}

function ThreadRow(props: {
  thread: ThreadMeta
  active: boolean
  running: boolean
  editing: boolean
  projectName?: string
  onEdit: () => void
  onEditDone: () => void
}) {
  const t = useT()
  const { thread, active, running, editing } = props
  const title = displayThreadTitle(thread, t)
  const menu: MenuEntry[] = [
    { label: t('重命名'), icon: <IconEdit size={14} />, onSelect: props.onEdit },
    {
      label: t('分叉对话'),
      icon: <IconBranch size={14} />,
      disabled: running,
      hint: running ? t('运行中') : undefined,
      onSelect: () => void forkThread(thread.id)
    },
    { label: thread.pinned ? t('取消置顶') : t('置顶'), icon: <IconPin size={14} />, onSelect: () => window.api.updateThread(thread.id, { pinned: !thread.pinned }) },
    {
      label: thread.archived ? t('取消归档') : t('归档'),
      icon: <IconArchive size={14} />,
      onSelect: () => window.api.updateThread(thread.id, { archived: !thread.archived })
    },
    'separator',
    {
      label: t('从 CLI 同步历史'),
      icon: <IconRefresh size={14} />,
      disabled: !thread.chatId || running,
      onSelect: () => {
        if (thread.source === 'cli' || confirm(t('用 Cursor CLI 本地保存的记录替换此对话的显示内容？\n（耗时、token 统计等本应用记录的信息会丢失）'))) {
          syncThreadFromCli(thread.id)
        }
      }
    },
    {
      label: t('复制 CLI 会话 ID'),
      icon: <IconCopy size={14} />,
      disabled: !thread.chatId,
      onSelect: () => {
        navigator.clipboard.writeText(thread.chatId!)
        toast(t('已复制会话 ID，可用 agent --resume <id> 在终端继续'))
      }
    },
    ...(thread.cwd && !window.api.isRemote ? [{ label: t('打开工作目录'), icon: <IconFolder size={14} />, onSelect: () => window.api.openPath(thread.cwd!) }] : []),
    'separator',
    {
      label: t('删除对话'),
      icon: <IconTrash size={14} />,
      danger: true,
      onSelect: () => {
        if (confirm(t('删除对话「{title}」？此操作不可撤销。', { title }))) {
          window.api.deleteThread(thread.id)
          setState((s) => (s.view.kind === 'thread' && s.view.id === thread.id ? { view: { kind: 'home', projectId: thread.projectId } } : {}))
        }
      }
    }
  ]
  return (
    <div
      className={`thread-row ${active ? 'active' : ''} ${thread.archived ? 'archived' : ''}`}
      onClick={() => openThread(thread.id)}
      onDoubleClick={props.onEdit}
      title={thread.preview ? `${title}\n\n${thread.preview}` : title}
    >
      <span className="thread-status">
        {running ? <Spinner size={11} /> : thread.unread ? <span className="unread-dot" /> : thread.pinned ? <IconPin size={11} /> : null}
      </span>
      {editing ? (
        <InlineRename
          value={title}
          onDone={(v) => {
            if (v) window.api.updateThread(thread.id, { title: v })
            props.onEditDone()
          }}
        />
      ) : (
        <>
          <span className="thread-title">
            {title}
            {props.projectName && <span className="thread-project"> · {props.projectName}</span>}
          </span>
          <span className="badge">{cliTitle(threadCli(thread))}</span>
        </>
      )}
      <span className="thread-time">{relativeTime(thread.updatedAt)}</span>
      <div className="row-tools" onClick={(e) => e.stopPropagation()}>
        <MenuButton className="icon-btn tiny" items={menu} placement="bottom-end" title={t('对话操作')}>
          <IconMore size={14} />
        </MenuButton>
      </div>
    </div>
  )
}
