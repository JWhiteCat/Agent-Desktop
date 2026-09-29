import { useState } from 'react'
import type { ToolItem } from '@shared/types'
import { DiffLines, parseUnifiedDiff } from '../../lib/diff'
import { duration } from '../../lib/format'
import { errorOf, successOf, summarizeTool, toolDiff, type ToolKind } from '../../lib/tools'
import {
  IconChevronDown,
  IconChevronRight,
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
} from '../icons'

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
