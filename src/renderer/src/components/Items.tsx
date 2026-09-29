import { createContext, isValidElement, memo, useContext, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { quoteModel } from '@shared/model-prices'
import { formatAnswers, parseQuestionBlock, QUESTION_BLOCK_LANG } from '@shared/questions'
import type { CliProvider, Item, NoticeItem, QuestionAnswer, QuestionItem, QuestionPrompt, ResultItem, ThinkingItem, ToolItem, UserItem } from '@shared/types'
import { answerQuestion, useStore } from '../store'
import { compactNumber, duration, formatUsd } from '../lib/format'
import { groupModels, modelCaption } from '../lib/models'
import { DiffLines, parseUnifiedDiff } from '../lib/diff'
import { errorOf, planPath, planUriOf, successOf, summarizeTool, toolDiff, type ToolKind } from '../lib/tools'
import {
  IconBrain,
  IconBranch,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconEdit,
  IconFile,
  IconFolder,
  IconGlobe,
  IconList,
  IconSearch,
  IconSparkle,
  IconTerminal,
  IconTrash,
  IconX,
  Spinner
} from './icons'

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={className ?? 'icon-btn tiny'}
      title="复制"
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  )
}

function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang ?? 'text'}</span>
        <CopyButton text={text} />
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  )
}

const mdComponents: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href) window.api.openExternal(href)
      }}
    >
      {children}
    </a>
  ),
  pre: ({ children }) => {
    const code = isValidElement<{ className?: string; children?: React.ReactNode }>(children) ? children.props : undefined
    const text = String(code?.children ?? '').replace(/\n$/, '')
    const lang = /language-([\w+-]+)/.exec(code?.className ?? '')?.[1]
    if (lang === QUESTION_BLOCK_LANG) return <QuestionBlock body={text} />
    return <CodeBlock lang={lang} text={text} />
  },
  code: ({ children }) => <code className="inline-code">{children}</code>,
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

function ForkButton({ onFork }: { onFork: () => void }) {
  return (
    <button
      className="icon-btn tiny"
      title="从这里分叉"
      onClick={(e) => {
        e.stopPropagation()
        onFork()
      }}
    >
      <IconBranch size={13} />
    </button>
  )
}

export function UserMessage({ item, onFork }: { item: UserItem; onFork?: () => void }) {
  return (
    <div className="msg-user">
      <div className="bubble">{item.text}</div>
      <div className="msg-actions">
        <CopyButton text={item.text} />
        {onFork && <ForkButton onFork={onFork} />}
      </div>
    </div>
  )
}

export function AssistantMessage({ text, streaming, onFork }: { text: string; streaming?: boolean; onFork?: () => void }) {
  const actions = useContext(TurnActionsContext)
  const value = useMemo(() => ({ ...actions, streaming }), [actions, streaming])
  return (
    <div className="msg-assistant-wrap">
      <div className={`msg-assistant ${streaming ? 'streaming' : ''}`}>
        <TurnActionsContext.Provider value={value}>
          <Markdown text={text} />
        </TurnActionsContext.Provider>
      </div>
      {onFork && !streaming && (
        <div className="msg-actions">
          <ForkButton onFork={onFork} />
        </div>
      )}
    </div>
  )
}

export function ThinkingBlock({ item }: { item: ThinkingItem }) {
  const [open, setOpen] = useState(false)
  const secs = item.endedAt && item.startedAt ? Math.max(1, Math.round((item.endedAt - item.startedAt) / 1000)) : undefined
  return (
    <div className="step">
      <div className="step-head" onClick={() => setOpen((o) => !o)}>
        <span className="step-icon">{item.done ? <IconBrain size={14} /> : <Spinner size={12} />}</span>
        <span className={`step-verb ${item.done ? '' : 'shimmer'}`}>{item.done ? (secs ? `思考了 ${secs} 秒` : '思考') : '思考中'}</span>
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
      </div>
      {open && item.text.trim() && <div className="step-body thinking-text">{item.text.trim()}</div>}
    </div>
  )
}

const KIND_ICON: Record<ToolKind, React.ReactNode> = {
  read: <IconFile size={14} />,
  edit: <IconEdit size={14} />,
  shell: <IconTerminal size={14} />,
  search: <IconSearch size={14} />,
  list: <IconFolder size={14} />,
  delete: <IconTrash size={14} />,
  todo: <IconList size={14} />,
  web: <IconGlobe size={14} />,
  mcp: <IconSparkle size={14} />,
  task: <IconSparkle size={14} />,
  other: <IconSparkle size={14} />
}

function ToolDetail({ item }: { item: ToolItem }) {
  const s = successOf(item)
  const err = errorOf(item)
  const sum = summarizeTool(item)
  if (sum.kind === 'shell') {
    const out = [s?.stdout, s?.stderr].filter(Boolean).join('\n') || s?.interleavedOutput || ''
    return (
      <div className="tool-detail">
        <div className="shell-cmd">
          <span className="prompt">$</span> {item.args?.command}
        </div>
        {(out || err) && <pre className="shell-out">{(out || err || '').replace(/\r\n/g, '\n').trimEnd()}</pre>}
        {s?.exitCode !== undefined && <div className="muted small">退出码 {s.exitCode}{s.executionTime ? ` · ${duration(s.executionTime)}` : ''}</div>}
      </div>
    )
  }
  const diff = toolDiff(item)
  if (diff) {
    const files = parseUnifiedDiff(diff)
    return (
      <div className="tool-detail">
        {files.map((f, i) => (
          <DiffLines key={i} lines={f.lines} />
        ))}
      </div>
    )
  }
  if (typeof item.args === 'string' && sum.kind === 'edit') {
    return (
      <div className="tool-detail">
        <DiffLines lines={item.args.split(/\r?\n/)} />
      </div>
    )
  }
  if (sum.kind === 'todo' && Array.isArray(item.args?.todos)) {
    return (
      <div className="tool-detail todo-list">
        {item.args.todos.map((t: any, i: number) => (
          <div key={i} className={`todo ${String(t.status ?? '').toLowerCase()}`}>
            <span className="todo-box">{/complete/i.test(t.status) ? '✓' : /progress/i.test(t.status) ? '•' : ''}</span>
            <span>{t.content ?? t.title ?? JSON.stringify(t)}</span>
          </div>
        ))}
      </div>
    )
  }
  const payload = { args: item.args, ...(item.result ? { result: item.result } : {}) }
  const json = JSON.stringify(payload, null, 2)
  return (
    <div className="tool-detail">
      <pre className="json">{json.length > 20000 ? `${json.slice(0, 20000)}\n…` : json}</pre>
    </div>
  )
}

export function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const sum = summarizeTool(item)
  const failed = item.status === 'error'
  return (
    <div className={`step ${failed ? 'failed' : ''}`}>
      <div className="step-head" onClick={() => setOpen((o) => !o)} title={item.tool}>
        <span className="step-icon">{item.status === 'running' ? <Spinner size={12} /> : KIND_ICON[sum.kind]}</span>
        <span className={`step-verb ${item.status === 'running' ? 'shimmer' : ''}`}>{sum.verb}</span>
        {sum.target && <span className={`step-target ${sum.kind === 'shell' ? 'mono' : ''}`}>{sum.target}</span>}
        {sum.added !== undefined && sum.added > 0 && <span className="add small">+{sum.added}</span>}
        {sum.removed !== undefined && sum.removed > 0 && <span className="del small">−{sum.removed}</span>}
        {sum.meta && <span className="step-meta">{sum.meta}</span>}
        {failed && <IconX size={12} className="del" />}
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
      </div>
      {open && (
        <div className="step-body">
          <ToolDetail item={item} />
        </div>
      )}
    </div>
  )
}

export function Notice({ item }: { item: NoticeItem }) {
  return <div className={`notice ${item.level}`}>{item.text}</div>
}

export function ResultFooter({ item, text, fallbackModel, cli = 'cursor' }: { item: ResultItem; text?: string; fallbackModel?: string; cli?: CliProvider }) {
  const provider = item.cli ?? cli
  const models = useStore((s) => s.modelsByCli[provider])
  const groups = useMemo(() => groupModels(models), [models])
  const u = item.usage
  const tokens = u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) : 0
  const modelId = item.model || fallbackModel || ''
  const caption = modelId ? modelCaption(groups, modelId) : ''
  const quote = modelId && u ? quoteModel(modelId, u, provider) : undefined
  const priceSource = provider === 'codex' ? 'OpenAI API 公开标价' : 'Cursor 公开标价'
  const quota = provider === 'codex' ? item.quotaUsage : undefined
  const quotaText = [
    quotaPercent('周额度', quota?.weekly),
    quotaPercent('5小时', quota?.fiveHour)
  ].filter(Boolean).join(' · ')
  return (
    <div className="result-footer">
      {text && <CopyButton text={text} />}
      {item.durationMs !== undefined && <span>{duration(item.durationMs)}</span>}
      {tokens > 0 && (
        <span title={`输入 ${u?.inputTokens ?? 0} · 输出 ${u?.outputTokens ?? 0} · 缓存读 ${u?.cacheReadTokens ?? 0} · 缓存写 ${u?.cacheWriteTokens ?? 0}`}>
          {compactNumber(tokens)} tokens
        </span>
      )}
      {caption && <span title={caption === modelId ? undefined : modelId}>{caption}</span>}
      {quote && (
        <span title={quote.costUsd == null ? 'Auto 和价目表没有的模型未计入费用' : `估算 $${quote.costUsd}（${priceSource}）`}>
          {formatUsd(quote.costUsd)}
        </span>
      )}
      {quotaText && (
        <span title="本次额度消耗估算：根据本轮前后账号已用额度的百分点增量计算。接口取整、更新延迟及其他客户端的使用可能影响结果。0% 表示账号百分比未变化，不代表本次没有消耗。">
          {quotaText}
        </span>
      )}
    </div>
  )
}

function quotaPercent(label: string, value: number | undefined): string | undefined {
  if (value == null || !Number.isFinite(value) || value < 0) return undefined
  const amount = value > 0 && value < 0.01 ? '<0.01' : String(Number(value.toFixed(2)))
  return `${label} ${amount}%`
}

/** Actions that only make sense on the newest part of an idle thread. */
export interface TurnActions {
  /** Sends a reply in the current mode. */
  reply?: (text: string) => Promise<void> | void
  /** Starts implementing a CreatePlan result in agent mode. */
  buildPlan?: (item: ToolItem) => Promise<void> | void
  /** The CreatePlan item that `buildPlan` applies to. */
  planId?: string
}

const TurnActionsContext = createContext<TurnActions & { streaming?: boolean }>({})

interface QuestionFormProps {
  title?: string
  questions: QuestionPrompt[]
  answers?: QuestionAnswer[]
  /** Shown instead of the buttons once the form can no longer be submitted. */
  status?: string
  onSubmit?: (answers: QuestionAnswer[]) => Promise<void> | void
  onSkip?: () => Promise<void> | void
}

function QuestionForm({ title, questions, answers, status, onSubmit, onSkip }: QuestionFormProps) {
  const [selected, setSelected] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {}
    for (const answer of answers ?? []) init[answer.questionId] = answer.selectedOptionIds
    return init
  })
  const [sending, setSending] = useState(false)
  const locked = !onSubmit || sending

  const picked = (questionId: string): string[] => {
    if (answers) return answers.find((a) => a.questionId === questionId)?.selectedOptionIds ?? []
    return selected[questionId] ?? []
  }

  const choose = (q: QuestionPrompt, optionId: string) => {
    if (locked) return
    setSelected((prev) => {
      const cur = prev[q.id] ?? []
      const next = q.allowMultiple ? (cur.includes(optionId) ? cur.filter((id) => id !== optionId) : [...cur, optionId]) : [optionId]
      return { ...prev, [q.id]: next }
    })
  }

  const complete = questions.every((q) => picked(q.id).length > 0)

  const run = async (action: () => Promise<void> | void) => {
    setSending(true)
    try {
      await action()
    } catch {
      setSending(false)
    }
  }

  const submit = () => {
    if (locked || !complete || !onSubmit) return
    void run(() => onSubmit(questions.map((q) => ({ questionId: q.id, selectedOptionIds: picked(q.id) }))))
  }

  const skip = () => {
    if (locked || !onSkip) return
    void run(onSkip)
  }

  return (
    <div className={`question-card ${locked ? 'locked' : ''}`}>
      <div className="question-title">{title || '需要你的选择'}</div>
      {questions.map((q) => (
        <div key={q.id} className="question-block">
          <div className="question-prompt">
            {q.prompt}
            {q.allowMultiple && <span className="question-hint">可多选</span>}
          </div>
          <div className="question-options" role={q.allowMultiple ? 'group' : 'radiogroup'}>
            {q.options.map((o) => {
              const on = picked(q.id).includes(o.id)
              return (
                <button
                  key={o.id}
                  type="button"
                  role={q.allowMultiple ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  className={`question-opt ${on ? 'selected' : ''}`}
                  onClick={() => choose(q, o.id)}
                >
                  <span className="question-mark">{on ? '✓' : ''}</span>
                  <span>{o.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {onSubmit ? (
        <div className="question-actions">
          <button type="button" className="question-submit" disabled={!complete || sending} onClick={submit}>
            {sending ? '提交中' : '继续'}
          </button>
          {onSkip && (
            <button type="button" className="question-skip" disabled={sending} onClick={skip}>
              跳过
            </button>
          )}
        </div>
      ) : (
        status && <div className="question-status">{status}</div>
      )}
    </div>
  )
}

export function QuestionCard({ item, threadId }: { item: QuestionItem; threadId: string }) {
  const pending = item.status === 'pending'
  return (
    <QuestionForm
      title={item.title}
      questions={item.questions}
      answers={item.status === 'answered' ? item.answers : undefined}
      status={pending ? undefined : item.status === 'answered' ? '已提交' : '已跳过'}
      onSubmit={pending ? (answers) => answerQuestion(threadId, item.id, answers) : undefined}
      onSkip={pending ? () => answerQuestion(threadId, item.id, null) : undefined}
    />
  )
}

/** A ```questions block from the model, answered by sending the picks as the next message. */
function QuestionBlock({ body }: { body: string }) {
  const { reply, streaming } = useContext(TurnActionsContext)
  const set = useMemo(() => parseQuestionBlock(body), [body])
  if (!set) {
    if (streaming) return <div className="question-card locked question-loading">正在准备问题…</div>
    return <CodeBlock lang={QUESTION_BLOCK_LANG} text={body} />
  }
  return (
    <QuestionForm
      title={set.title}
      questions={set.questions}
      status={reply || streaming ? undefined : '已回答'}
      onSubmit={reply ? (answers) => reply(formatAnswers(set, answers)) : undefined}
      onSkip={reply ? () => reply('这些问题先跳过，按你的判断继续。') : undefined}
    />
  )
}

function PlanCard({ item }: { item: ToolItem }) {
  const { buildPlan, planId } = useContext(TurnActionsContext)
  const [open, setOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const a = typeof item.args === 'object' && item.args ? item.args : {}
  const plan = typeof a.plan === 'string' ? a.plan.trim() : ''
  const todos: any[] = Array.isArray(a.todos) ? a.todos : []
  const uri = planUriOf(item)
  const running = item.status === 'running'
  const canBuild = !!buildPlan && planId === item.id && item.status === 'success'

  const build = async () => {
    if (!buildPlan || starting) return
    setStarting(true)
    try {
      await buildPlan(item)
    } catch {
      setStarting(false)
    }
  }

  return (
    <div className={`plan-card ${item.status === 'error' ? 'failed' : ''}`}>
      <div className="plan-head">
        <span className="step-icon">{running ? <Spinner size={12} /> : <IconList size={14} />}</span>
        <span className="plan-title">{a.name || (running ? '正在制定计划' : '计划')}</span>
        {uri && !window.api.isRemote && (
          <button className="icon-btn tiny" title="打开计划文件" onClick={() => window.api.openPath(planPath(uri))}>
            <IconFile size={13} />
          </button>
        )}
      </div>
      {a.overview && <div className="plan-overview">{a.overview}</div>}
      {todos.length > 0 && (
        <div className="todo-list plan-todos">
          {todos.map((t, i) => (
            <div key={t.id ?? i} className={`todo ${String(t.status ?? '').toLowerCase()}`}>
              <span className="todo-box">{/complete/i.test(t.status) ? '✓' : ''}</span>
              <span>{t.content ?? t.title ?? String(t.id ?? '')}</span>
            </div>
          ))}
        </div>
      )}
      {plan && (
        <>
          <button className="plan-toggle" onClick={() => setOpen((o) => !o)}>
            {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
            <span>{open ? '收起计划' : '查看完整计划'}</span>
          </button>
          {open && (
            <div className="plan-body">
              <Markdown text={plan} />
            </div>
          )}
        </>
      )}
      {item.status === 'error' && <div className="plan-error">{errorOf(item) ?? '计划创建失败'}</div>}
      {canBuild && (
        <div className="question-actions">
          <button type="button" className="question-submit" disabled={starting} onClick={build}>
            {starting ? '正在启动' : '执行计划'}
          </button>
          <span className="muted small">切换到 Agent 模式按计划实施</span>
        </div>
      )}
    </div>
  )
}

export function TurnActionsProvider({ value, children }: { value: TurnActions & { streaming?: boolean }; children: React.ReactNode }) {
  return <TurnActionsContext.Provider value={value}>{children}</TurnActionsContext.Provider>
}

export function StepItem({
  item,
  streaming,
  threadId,
  onFork
}: {
  item: Item
  streaming?: boolean
  threadId?: string
  onFork?: () => void
}) {
  switch (item.kind) {
    case 'assistant':
      return <AssistantMessage text={item.text} streaming={streaming} onFork={onFork} />
    case 'thinking':
      return <ThinkingBlock item={item} />
    case 'tool':
      return item.tool === 'createPlan' ? <PlanCard item={item} /> : <ToolRow item={item} />
    case 'question':
      return threadId ? <QuestionCard item={item} threadId={threadId} /> : null
    case 'notice':
      return <Notice item={item} />
    default:
      return null
  }
}
