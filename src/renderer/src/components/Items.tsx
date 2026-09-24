import { isValidElement, memo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Item, NoticeItem, ResultItem, ThinkingItem, ToolItem, UserItem } from '@shared/types'
import { compactNumber, duration } from '../lib/format'
import { DiffLines, parseUnifiedDiff } from '../lib/diff'
import { errorOf, successOf, summarizeTool, toolDiff, type ToolKind } from '../lib/tools'
import {
  IconBrain,
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

export function UserMessage({ item }: { item: UserItem }) {
  return (
    <div className="msg-user">
      <div className="bubble">{item.text}</div>
      <div className="msg-actions">
        <CopyButton text={item.text} />
      </div>
    </div>
  )
}

export function AssistantMessage({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`msg-assistant ${streaming ? 'streaming' : ''}`}>
      <Markdown text={text} />
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

export function ResultFooter({ item, text }: { item: ResultItem; text?: string }) {
  const u = item.usage
  const tokens = u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) : 0
  return (
    <div className="result-footer">
      {text && <CopyButton text={text} />}
      {item.durationMs !== undefined && <span>{duration(item.durationMs)}</span>}
      {tokens > 0 && (
        <span title={`输入 ${u?.inputTokens ?? 0} · 输出 ${u?.outputTokens ?? 0} · 缓存读 ${u?.cacheReadTokens ?? 0} · 缓存写 ${u?.cacheWriteTokens ?? 0}`}>
          {compactNumber(tokens)} tokens
        </span>
      )}
    </div>
  )
}

export function StepItem({ item, streaming }: { item: Item; streaming?: boolean }) {
  switch (item.kind) {
    case 'assistant':
      return <AssistantMessage text={item.text} streaming={streaming} />
    case 'thinking':
      return <ThinkingBlock item={item} />
    case 'tool':
      return <ToolRow item={item} />
    case 'notice':
      return <Notice item={item} />
    default:
      return null
  }
}
