import { useT } from '../lib/i18n'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FORK_COMMAND, mergeCommands } from '@shared/commands'
import { displayThreadTitle } from '@shared/thread-title'
import { isBackgroundAgentItem, mergeInterruptedAssistantMessages } from '@shared/transcript'
import { cliTitle, threadCli, type AssistantItem, type CliProvider, type Item, type ResultItem, type ThreadMeta, type ToolItem, type UserItem } from '@shared/types'
import { DiffFileView, collectEditedFiles } from '../lib/diff'
import { duration, shortPath } from '../lib/format'
import { planPath, planUriOf } from '../lib/tools'
import { defaultModelFor, favoritesFor, modelForChat, projectModelFor } from '../lib/model-prefs'
import { chatModel, cliCommands, forkThread, prepareCommands, sendMessage, setCliProvider, useStore } from '../store'
import { Composer, type ComposerHandle } from './Composer'
import { IconBranch, IconChevronDown, IconChevronRight, IconCursor, IconDiff, IconFolder, Spinner } from './icons'
import { ResultFooter, StepItem, TurnActionsProvider, UserMessage, type TurnActions } from './Items'
import { MarkdownDirectoryContext } from './items/Markdown'

interface Turn {
  key: string
  user?: UserItem
  steps: Item[]
  result?: ResultItem
}

function groupTurns(items: Item[]): Turn[] {
  const turns: Turn[] = []
  let cur: Turn | undefined
  for (const it of mergeInterruptedAssistantMessages(items)) {
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

function TurnFiles({ steps, cwd }: { steps: Item[]; cwd: string }) {
  const t = useT()
  const files = useMemo(() => collectEditedFiles(steps, cwd), [steps, cwd, t])
  if (!files.length) return null
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  return (
    <div className="turn-files">
      <div className="turn-files-label">
        <span>{t('修改了 {count} 个文件', { count: files.length })}</span>
        {added > 0 && <span className="add">+{added}</span>}
        {removed > 0 && <span className="del">−{removed}</span>}
      </div>
      {files.map((f) => (
        <DiffFileView key={f.path} file={f} defaultOpen={false} />
      ))}
    </div>
  )
}

function TurnView({
  turn,
  live,
  threadId,
  cwd,
  fallbackModel,
  cli,
  onFork
}: {
  turn: Turn
  live: boolean
  threadId: string
  cwd: string
  fallbackModel?: string
  cli: CliProvider
  onFork?: (itemId: string) => void
}) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const lastAssistantIdx = useMemo(() => {
    for (let i = turn.steps.length - 1; i >= 0; i--) if (turn.steps[i].kind === 'assistant') return i
    return -1
  }, [turn.steps])

  const finalText = lastAssistantIdx >= 0 ? (turn.steps[lastAssistantIdx] as AssistantItem).text : undefined

  if (live) {
    // A background completion can arrive while the earlier assistant item is
    // still streaming. It does not end that message or its question loading UI.
    let activeIndex = turn.steps.length - 1
    while (activeIndex >= 0 && isBackgroundAgentItem(turn.steps[activeIndex])) activeIndex--
    const last = turn.steps[activeIndex]
    const streamingText = last?.kind === 'assistant'
    const waitingForUser = turn.steps.some((s) => s.kind === 'question' && s.status === 'pending')
    const busy = waitingForUser || (last && (last.kind === 'tool' ? last.status === 'running' : last.kind === 'thinking' && !last.done))
    return (
      <div className="turn">
        {turn.user && <UserMessage item={turn.user} />}
        {turn.steps.map((s, i) => (
          <StepItem key={s.id} item={s} threadId={threadId} streaming={streamingText && i === activeIndex} />
        ))}
        {!streamingText && !busy && (
          <div className="working">
            <Spinner size={12} />
            <span className="shimmer">{turn.steps.length ? t('处理中') : cli === 'codex' ? t('正在启动 codex') : cli === 'claude' ? t('正在启动 claude') : t('正在启动 agent')}</span>
          </div>
        )}
      </div>
    )
  }

  const keepVisible = (s: Item, i: number) =>
    s.kind === 'question' || s.kind === 'notice' || (s.kind === 'tool' && s.tool === 'createPlan') || i === lastAssistantIdx
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
              {workMs
                ? t('已处理 {duration} · {count} 个步骤', { duration: duration(workMs), count: intermediate.length })
                : t('已处理 · {count} 个步骤', { count: intermediate.length })}
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
      <TurnFiles steps={turn.steps} cwd={cwd} />
      {turn.result && <ResultFooter item={turn.result} text={finalText} fallbackModel={fallbackModel} cli={cli} />}
    </div>
  )
}

interface Props {
  thread: ThreadMeta
  changesOpen: boolean
  onToggleChanges: () => void
}

export function ThreadView({ thread, changesOpen, onToggleChanges }: Props) {
  const t = useT()
  const items = useStore((s) => s.items[thread.id])
  const running = useStore((s) => s.app.running.includes(thread.id))
  const project = useStore((s) => s.app.projects.find((p) => p.id === thread.projectId))
  const settings = useStore((s) => s.app.settings)
  const cli = threadCli(thread)
  const models = useStore((s) => s.modelsByCli[cli] ?? s.models)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const composer = useRef<ComposerHandle>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const title = displayThreadTitle(thread, t)

  const ownCommands = useStore((s) => s.commandsByThread[thread.id])
  const cachedCommands = useStore((s) => cliCommands(s, cli))
  const commands = useMemo(() => {
    const remote = ownCommands?.length ? ownCommands : cachedCommands
    return mergeCommands(items && items.length > 0 ? [FORK_COMMAND] : [], remote)
  }, [items, ownCommands, cachedCommands])
  const turns = useMemo(() => groupTurns(items ?? []), [items])
  const latestPlan = useMemo(() => {
    const list = items ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i]
      if (it.kind === 'tool' && it.tool === 'createPlan') return it
    }
    return undefined
  }, [items])

  const idleActions = useMemo<TurnActions>(
    () => ({
      reply: (text) => composer.current?.send(text),
      buildPlan: (plan: ToolItem) => {
        const uri = planUriOf(plan)
        const name = typeof plan.args?.name === 'string' && plan.args.name ? plan.args.name : t('上面的计划')
        const text = [t('按照计划「{name}」开始实施。', { name }), uri ? t('计划文件：{path}', { path: planPath(uri) }) : '', t('按计划里的待办逐项完成，完成后简要汇报改动。')]
          .filter(Boolean)
          .join('\n')
        stick.current = true
        return composer.current?.send(text, { mode: 'agent' })
      },
      planId: latestPlan?.id
    }),
    [latestPlan?.id, t]
  )
  const noActions = useMemo<TurnActions>(() => ({}), [])
  const olderActions = useMemo<TurnActions>(() => ({ buildPlan: idleActions.buildPlan, planId: idleActions.planId }), [idleActions])

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
              defaultValue={title}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v && v !== title) window.api.updateThread(thread.id, { title: v })
                setEditingTitle(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditingTitle(false)
              }}
            />
          ) : (
            <h1 onDoubleClick={() => setEditingTitle(true)} title={t('双击重命名')}>
              {title}
            </h1>
          )}
          <span className="header-project" title={cwd}>
            {project?.name ?? t('未知项目')}
          </span>
          {isWorktree && (
            <span className="badge" title={cwd}>
              <IconBranch size={12} /> worktree
            </span>
          )}
          <span className="badge">{cliTitle(cli)}</span>
          {thread.source === 'cli' && <span className="badge">{t('CLI 导入')}</span>}
        </div>
        <div className="header-actions no-drag">
          {thread.modelLabel && <span className="muted small model-label">{thread.modelLabel}</span>}
          <button className="icon-btn" title={t('分叉对话（/fork）')} disabled={running || !items?.length} onClick={() => void forkThread(thread.id)}>
            <IconBranch />
          </button>
          {!window.api.isRemote && (
            <>
              <button className="icon-btn" title={t('在文件管理器中打开 {path}', { path: shortPath(cwd) })} onClick={() => window.api.openPath(cwd)}>
                <IconFolder />
              </button>
              <button className="icon-btn" title={t('在 Cursor 中打开')} onClick={() => window.api.openInEditor(cwd)}>
                <IconCursor />
              </button>
            </>
          )}
          <button className={`icon-btn ${changesOpen ? 'active' : ''}`} title={t('变更面板 (Ctrl+Shift+D)')} onClick={onToggleChanges}>
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
        <MarkdownDirectoryContext.Provider value={cwd}>
          <div className="messages-inner">
            {!items && (
              <div className="center-hint">
                <Spinner />
              </div>
            )}
            {turns.map((t, i) => {
              const last = i === turns.length - 1
              const actions = running ? noActions : last ? idleActions : olderActions
              return (
                <TurnActionsProvider key={t.key} value={actions}>
                  <TurnView
                    turn={t}
                    threadId={thread.id}
                    cwd={cwd}
                    fallbackModel={thread.model}
                    cli={cli}
                    live={running && last}
                    onFork={running ? undefined : (itemId) => void forkThread(thread.id, itemId)}
                  />
                </TurnActionsProvider>
              )
            })}
            {items && items.length === 0 && !running && <div className="center-hint muted">{t('发送第一条消息开始对话')}</div>}
          </div>
        </MarkdownDirectoryContext.Provider>
      </div>

      <div className="composer-dock">
        <Composer
          key={thread.id}
          ref={composer}
          projectId={thread.projectId}
          running={running}
          cli={cli}
          cliDisabled={running}
          cliNote={running ? t('对话进行中，结束后再切换 CLI') : t('切换后，下一条消息会用所选 CLI 新开一段会话，本机记录仍保留')}
          onCliChange={(next) => {
            if (running) return
            setCliProvider(next)
            const model = chatModel(thread.projectId, next)
            void window.api.updateThread(thread.id, { cli: next, model })
            return model
          }}
          initial={{
            model: thread.model || modelForChat(models, favoritesFor(settings, cli), defaultModelFor(settings, cli), projectModelFor(project, cli), settings.modelPreferences?.[cli]),
            mode: thread.mode,
            force: thread.force ?? settings.force,
            cli
          }}
          placeholder={
            thread.chatId
              ? t('继续对话… 输入 / 查看命令')
              : commands.length
                ? t('描述任务，输入 / 查看命令，Enter 发送')
                : t('描述任务，Enter 发送，Shift+Enter 换行')
          }
          commands={commands}
          onPrepare={thread.chatId ? (opts) => void prepareCommands(thread.id, opts) : undefined}
          onForceChange={(force) => void window.api.updateThread(thread.id, { force })}
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
