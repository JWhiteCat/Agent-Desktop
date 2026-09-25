import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, ThreadMeta } from '@shared/types'
import { threadCli } from '@shared/types'
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

const COLLAPSED_LIMIT = 6

interface Props {
  onOpenSettings: () => void
  onOpenImport: () => void
}

function sortThreads(threads: ThreadMeta[]): ThreadMeta[] {
  return threads.slice().sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
}

export const Sidebar = forwardRef<HTMLInputElement, Props>(function Sidebar({ onOpenSettings, onOpenImport }, searchRef) {
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
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.preview ?? '').toLowerCase().includes(q) ||
        (projectName.get(t.projectId) ?? '').toLowerCase().includes(q)
    )
  }, [query, threads, projects])

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
          <span>新对话</span>
          <kbd>{window.api.platform === 'darwin' ? '⌘N' : 'Ctrl+N'}</kbd>
        </button>
        <div className="search-box">
          <IconSearch size={14} />
          <input
            ref={searchRef}
            value={query}
            placeholder="搜索对话"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          />
          {query && (
            <button className="icon-btn tiny" onClick={() => setQuery('')}>
              <IconX size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="sidebar-scroll">
        {results ? (
          <div className="section">
            <div className="section-title">
              <span>搜索结果 · {results.length}</span>
            </div>
            {results.length === 0 && <div className="empty-hint">没有匹配的对话</div>}
            {results.map((t) => renderThread(t, projects.find((p) => p.id === t.projectId)?.name))}
          </div>
        ) : (
          <div className="section">
            <div className="section-title">
              <span>项目</span>
              <div className="section-tools">
                <MenuButton
                  className="icon-btn tiny"
                  title="更多"
                  placement="bottom-end"
                  items={[
                    { label: '导入 Cursor CLI 历史会话…', icon: <IconImport size={14} />, onSelect: onOpenImport },
                    {
                      label: '显示已归档对话',
                      icon: <IconArchive size={14} />,
                      checked: showArchived,
                      onSelect: () => window.api.updateSettings({ showArchived: !showArchived })
                    }
                  ]}
                >
                  <IconMore size={14} />
                </MenuButton>
                <button className="icon-btn tiny" title="添加项目" onClick={() => addProjectInteractive().then((id) => id && goHome(id))}>
                  <IconPlus size={14} />
                </button>
              </div>
            </div>
            {projects.length === 0 && (
              <div className="empty-hint">
                还没有项目。
                <button className="link-btn" onClick={() => addProjectInteractive().then((id) => id && goHome(id))}>
                  添加项目文件夹
                </button>
                <span> 或 </span>
                <button className="link-btn" onClick={onOpenImport}>
                  导入 CLI 历史
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
                      {list.length === 0 && <div className="empty-hint small">暂无对话</div>}
                      {shown.map((t) => renderThread(t))}
                      {list.length > COLLAPSED_LIMIT && (
                        <button className="show-more" onClick={() => setExpanded((e) => ({ ...e, [p.id]: !isExpanded }))}>
                          {isExpanded ? '收起' : `显示更多（${list.length - COLLAPSED_LIMIT}）`}
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
        <button className="nav-btn" onClick={onOpenSettings}>
          <IconSettings />
          <span>设置</span>
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
  const { project: p, index, total, editing } = props
  const projects = useStore((s) => s.app.projects)
  const move = (delta: number) => {
    const ids = projects.map((x) => x.id)
    const j = index + delta
    ;[ids[index], ids[j]] = [ids[j], ids[index]]
    window.api.reorderProjects(ids)
  }
  const menu: MenuEntry[] = [
    { label: '新对话', icon: <IconCompose size={14} />, onSelect: () => goHome(p.id) },
    ...(window.api.isRemote
      ? []
      : [
          { label: '在 Cursor 中打开', icon: <IconCursor size={14} />, onSelect: () => window.api.openInEditor(p.path) },
          { label: '在文件管理器中打开', icon: <IconFolder size={14} />, onSelect: () => window.api.openPath(p.path) }
        ]),
    { label: '重命名', icon: <IconEdit size={14} />, onSelect: props.onEdit },
    'separator',
    { label: '上移', disabled: index === 0, onSelect: () => move(-1) },
    { label: '下移', disabled: index === total - 1, onSelect: () => move(1) },
    'separator',
    {
      label: '移除项目',
      icon: <IconTrash size={14} />,
      danger: true,
      onSelect: () => {
        if (confirm(`移除项目「${p.name}」？\n该项目下的 ${props.count} 个对话记录也会从本应用中删除（不会删除磁盘上的文件）。`)) {
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
        <button className="icon-btn tiny" title="在此项目中新建对话" onClick={() => goHome(p.id)}>
          <IconCompose size={13} />
        </button>
        <MenuButton className="icon-btn tiny" items={menu} placement="bottom-end" title="项目操作">
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
  const { thread: t, active, running, editing } = props
  const menu: MenuEntry[] = [
    { label: '重命名', icon: <IconEdit size={14} />, onSelect: props.onEdit },
    {
      label: '分叉对话',
      icon: <IconBranch size={14} />,
      disabled: running,
      hint: running ? '运行中' : undefined,
      onSelect: () => void forkThread(t.id)
    },
    { label: t.pinned ? '取消置顶' : '置顶', icon: <IconPin size={14} />, onSelect: () => window.api.updateThread(t.id, { pinned: !t.pinned }) },
    {
      label: t.archived ? '取消归档' : '归档',
      icon: <IconArchive size={14} />,
      onSelect: () => window.api.updateThread(t.id, { archived: !t.archived })
    },
    'separator',
    {
      label: '从 CLI 同步历史',
      icon: <IconRefresh size={14} />,
      disabled: !t.chatId || running,
      onSelect: () => {
        if (t.source === 'cli' || confirm('用 Cursor CLI 本地保存的记录替换此对话的显示内容？\n（耗时、token 统计等本应用记录的信息会丢失）')) {
          syncThreadFromCli(t.id)
        }
      }
    },
    {
      label: '复制 CLI 会话 ID',
      icon: <IconCopy size={14} />,
      disabled: !t.chatId,
      onSelect: () => {
        navigator.clipboard.writeText(t.chatId!)
        toast('已复制会话 ID，可用 agent --resume <id> 在终端继续')
      }
    },
    ...(t.cwd && !window.api.isRemote ? [{ label: '打开工作目录', icon: <IconFolder size={14} />, onSelect: () => window.api.openPath(t.cwd!) }] : []),
    'separator',
    {
      label: '删除对话',
      icon: <IconTrash size={14} />,
      danger: true,
      onSelect: () => {
        if (confirm(`删除对话「${t.title}」？此操作不可撤销。`)) {
          window.api.deleteThread(t.id)
          setState((s) => (s.view.kind === 'thread' && s.view.id === t.id ? { view: { kind: 'home', projectId: t.projectId } } : {}))
        }
      }
    }
  ]
  return (
    <div
      className={`thread-row ${active ? 'active' : ''} ${t.archived ? 'archived' : ''}`}
      onClick={() => openThread(t.id)}
      onDoubleClick={props.onEdit}
      title={t.preview ? `${t.title}\n\n${t.preview}` : t.title}
    >
      <span className="thread-status">
        {running ? <Spinner size={11} /> : t.unread ? <span className="unread-dot" /> : t.pinned ? <IconPin size={11} /> : null}
      </span>
      {editing ? (
        <InlineRename
          value={t.title}
          onDone={(v) => {
            if (v) window.api.updateThread(t.id, { title: v })
            props.onEditDone()
          }}
        />
      ) : (
        <span className="thread-title">
          {t.title}
          {props.projectName && <span className="thread-project"> · {props.projectName}</span>}
        </span>
        <span className="badge">{threadCli(t) === 'codex' ? 'Codex' : 'Cursor'}</span>
      )}
      <span className="thread-time">{relativeTime(t.updatedAt)}</span>
      <div className="row-tools" onClick={(e) => e.stopPropagation()}>
        <MenuButton className="icon-btn tiny" items={menu} placement="bottom-end" title="对话操作">
          <IconMore size={14} />
        </MenuButton>
      </div>
    </div>
  )
}
