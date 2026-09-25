import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AssistantItem, Item, ResultItem, ThreadMeta, UserItem } from '@shared/types'
import { duration, shortPath } from '../lib/format'
import { forkThread, modelForChat, sendMessage, useStore } from '../store'
import { Composer, type ComposerHandle } from './Composer'
import { IconBranch, IconChevronDown, IconChevronRight, IconCursor, IconDiff, IconFolder, Spinner } from './icons'
import { ResultFooter, StepItem, UserMessage } from './Items'

interface Turn {
  key: string
  user?: UserItem
  steps: Item[]
  result?: ResultItem
}

function groupTurns(items: Item[]): Turn[] {
  const turns: Turn[] = []
  let cur: Turn | undefined
  for (const it of items) {
    if (it.kind === 'user') {
      cur = { key: it.id, user: it, steps: [] }
      turns.push(cur)
      continue
    }
    if (!cur) {
      cur = { key: it.id, steps: [] }
      turns.push(cur)
    }
    if (it.kind === 'result') cur.result = it
    else cur.steps.push(it)
  }
  return turns
}

function TurnView({
  turn,
  live,
  threadId,
  onFork
}: {
  turn: Turn
  live: boolean
  threadId: string
  onFork?: (itemId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const lastAssistantIdx = useMemo(() => {
    for (let i = turn.steps.length - 1; i >= 0; i--) if (turn.steps[i].kind === 'assistant') return i
    return -1
  }, [turn.steps])

  const finalText = lastAssistantIdx >= 0 ? (turn.steps[lastAssistantIdx] as AssistantItem).text : undefined

  if (live) {
    const last = turn.steps[turn.steps.length - 1]
    const streamingText = last?.kind === 'assistant'
    const waitingForUser = turn.steps.some((s) => s.kind === 'question' && s.status === 'pending')
    const busy = waitingForUser || (last && (last.kind === 'tool' ? last.status === 'running' : last.kind === 'thinking' && !last.done))
    return (
      <div className="turn">
        {turn.user && <UserMessage item={turn.user} />}
        {turn.steps.map((s, i) => (
          <StepItem key={s.id} item={s} threadId={threadId} streaming={streamingText && i === turn.steps.length - 1} />
        ))}
        {!streamingText && !busy && (
          <div className="working">
            <Spinner size={12} />
            <span className="shimmer">{turn.steps.length ? '处理中' : '正在启动 Cursor Agent'}</span>
          </div>
        )}
      </div>
    )
  }

  const keepVisible = (s: Item, i: number) => s.kind === 'question' || s.kind === 'notice' || i === lastAssistantIdx
  const intermediate = turn.steps.filter((s, i) => !keepVisible(s, i))
  const trailing = turn.steps.filter((s, i) => keepVisible(s, i))
  const workMs =
    turn.result?.durationMs ??
    (() => {
      const ends = turn.steps.map((s) => (s.kind === 'tool' || s.kind === 'thinking' ? s.endedAt ?? 0 : 0))
      const end = Math.max(0, ...ends)
      return turn.user && end ? end - turn.user.createdAt : undefined
    })()

  return (
    <div className="turn">
      {turn.user && <UserMessage item={turn.user} onFork={onFork ? () => onFork(turn.user!.id) : undefined} />}
      {intermediate.length > 0 && (
        <div className="worked">
          <button className="worked-toggle" onClick={() => setExpanded((e) => !e)}>
            <span>
              已处理{workMs ? ` ${duration(workMs)}` : ''} · {intermediate.length} 个步骤
            </span>
            {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </button>
        </div>
      )}
      {(expanded ? turn.steps : trailing).map((s) => (
        <StepItem
          key={s.id}
          item={s}
          threadId={threadId}
          onFork={onFork && s.kind === 'assistant' ? () => onFork(s.id) : undefined}
        />
      ))}
      {turn.result && <ResultFooter item={turn.result} text={finalText} />}
    </div>
  )
}

interface Props {
  thread: ThreadMeta
  changesOpen: boolean
  onToggleChanges: () => void
}

export function ThreadView({ thread, changesOpen, onToggleChanges }: Props) {
  const items = useStore((s) => s.items[thread.id])
  const running = useStore((s) => s.app.running.includes(thread.id))
  const project = useStore((s) => s.app.projects.find((p) => p.id === thread.projectId))
  const settings = useStore((s) => s.app.settings)
  const models = useStore((s) => s.models)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const composer = useRef<ComposerHandle>(null)
  const [editingTitle, setEditingTitle] = useState(false)

  const turns = useMemo(() => groupTurns(items ?? []), [items])

  useLayoutEffect(() => {
    stick.current = true
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
    composer.current?.focus()
  }, [thread.id])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items])

  useEffect(() => {
    if (thread.unread && document.hasFocus()) window.api.updateThread(thread.id, { unread: false })
  }, [thread.id, thread.unread])

  const cwd = thread.cwd ?? project?.path ?? ''
  const isWorktree = !!thread.worktree || (!!thread.cwd && !!project && thread.cwd.toLowerCase() !== project.path.toLowerCase())

  return (
    <div className="thread-view">
      <header className="main-header drag">
        <div className="header-title no-drag">
          {editingTitle ? (
            <input
              autoFocus
              className="title-input"
              defaultValue={thread.title}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v && v !== thread.title) window.api.updateThread(thread.id, { title: v })
                setEditingTitle(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditingTitle(false)
              }}
            />
          ) : (
            <h1 onDoubleClick={() => setEditingTitle(true)} title="双击重命名">
              {thread.title}
            </h1>
          )}
          <span className="header-project" title={cwd}>
            {project?.name ?? '未知项目'}
          </span>
          {isWorktree && (
            <span className="badge" title={cwd}>
              <IconBranch size={12} /> worktree
            </span>
          )}
          {thread.source === 'cli' && <span className="badge">CLI 导入</span>}
        </div>
        <div className="header-actions no-drag">
          {thread.modelLabel && <span className="muted small model-label">{thread.modelLabel}</span>}
          <button className="icon-btn" title="分叉对话（/fork）" disabled={running || !items?.length} onClick={() => void forkThread(thread.id)}>
            <IconBranch />
          </button>
          {!window.api.isRemote && (
            <>
              <button className="icon-btn" title={`在文件管理器中打开 ${shortPath(cwd)}`} onClick={() => window.api.openPath(cwd)}>
                <IconFolder />
              </button>
              <button className="icon-btn" title="在 Cursor 中打开" onClick={() => window.api.openInEditor(cwd)}>
                <IconCursor />
              </button>
            </>
          )}
          <button className={`icon-btn ${changesOpen ? 'active' : ''}`} title="变更面板 (Ctrl+Shift+D)" onClick={onToggleChanges}>
            <IconDiff />
          </button>
        </div>
      </header>

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="messages-inner">
          {!items && (
            <div className="center-hint">
              <Spinner />
            </div>
          )}
          {turns.map((t, i) => (
            <TurnView
              key={t.key}
              turn={t}
              threadId={thread.id}
              live={running && i === turns.length - 1}
              onFork={running ? undefined : (itemId) => void forkThread(thread.id, itemId)}
            />
          ))}
          {items && items.length === 0 && !running && <div className="center-hint muted">发送第一条消息开始对话</div>}
        </div>
      </div>

      <div className="composer-dock">
        <Composer
          key={thread.id}
          ref={composer}
          projectId={thread.projectId}
          running={running}
          initial={{ model: thread.model || modelForChat(models, settings.favoriteModels, settings.defaultModel, project?.model), mode: thread.mode, force: settings.force }}
          placeholder={thread.chatId ? '继续对话…' : '描述任务，Enter 发送，Shift+Enter 换行'}
          onSend={(text, opts) => {
            if (text.trim() === '/fork') {
              void forkThread(thread.id)
              return
            }
            stick.current = true
            return sendMessage(thread.id, text, opts)
          }}
          onStop={() => window.api.stop(thread.id)}
        />
      </div>
    </div>
  )
}
