import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { AgentMode } from '@shared/types'
import { loadModels, useStore, type SendOptions } from '../store'
import { IconArrowUp, IconBranch, IconChevronDown, IconFolder, IconList, IconRefresh, IconShield, IconSparkle, IconStop } from './icons'
import { MenuList, Popover } from './Menu'

export const MODES: { id: AgentMode; label: string; desc: string }[] = [
  { id: 'agent', label: 'Agent', desc: '可读写文件、执行命令' },
  { id: 'plan', label: 'Plan', desc: '只读分析，先给出方案' },
  { id: 'ask', label: 'Ask', desc: '只读问答，不做修改' }
]

export interface ComposerHandle {
  focus: () => void
  setText: (t: string) => void
}

interface Props {
  initial: SendOptions
  running?: boolean
  disabled?: boolean
  placeholder?: string
  showWorktree?: boolean
  footerLeft?: React.ReactNode
  onSend: (text: string, opts: SendOptions) => Promise<void> | void
  onStop?: () => void
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(props, ref) {
  const { running, disabled } = props
  const [text, setText] = useState('')
  const [opts, setOpts] = useState<SendOptions>(props.initial)
  const [sending, setSending] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    setText: (t) => {
      setText(t)
      requestAnimationFrame(() => ta.current?.focus())
    }
  }))

  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  }, [text])

  const canSend = !!text.trim() && !running && !disabled && !sending

  const submit = async () => {
    if (!canSend) return
    const value = text
    setSending(true)
    setText('')
    try {
      await props.onSend(value, opts)
    } catch {
      setText(value)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={`composer ${disabled ? 'disabled' : ''}`}>
      <textarea
        ref={ta}
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={props.placeholder ?? '描述任务，Enter 发送，Shift+Enter 换行'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape' && running) {
            props.onStop?.()
          }
        }}
      />
      <div className="composer-bar">
        <div className="composer-left">
          <ModePicker value={opts.mode} onChange={(mode) => setOpts((o) => ({ ...o, mode }))} />
          <ModelPicker value={opts.model} onChange={(model) => setOpts((o) => ({ ...o, model }))} />
          <button
            className={`pill ${opts.force ? 'pill-warn' : ''}`}
            title={opts.force ? '完全访问：命令无需确认直接执行（--force）' : '默认权限：遵循 CLI 权限配置'}
            onClick={() => setOpts((o) => ({ ...o, force: !o.force }))}
          >
            <IconShield size={13} />
            <span>{opts.force ? '完全访问' : '默认权限'}</span>
          </button>
          {props.showWorktree && (
            <button
              className={`pill ${opts.worktree ? 'pill-on' : ''}`}
              title="在隔离的 git worktree 中运行（--worktree）"
              onClick={() => setOpts((o) => ({ ...o, worktree: !o.worktree }))}
            >
              {opts.worktree ? <IconBranch size={13} /> : <IconFolder size={13} />}
              <span>{opts.worktree ? 'Worktree' : '本地'}</span>
            </button>
          )}
          {props.footerLeft}
        </div>
        {running ? (
          <button className="send-btn stop" title="停止 (Esc)" onClick={props.onStop}>
            <IconStop size={14} />
          </button>
        ) : (
          <button className="send-btn" title="发送 (Enter)" disabled={!canSend} onClick={submit}>
            <IconArrowUp size={16} />
          </button>
        )}
      </div>
    </div>
  )
})

function ModePicker({ value, onChange }: { value: AgentMode; onChange: (m: AgentMode) => void }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const current = MODES.find((m) => m.id === value) ?? MODES[0]
  return (
    <>
      <button ref={btn} className={`pill ${open ? 'active' : ''}`} onClick={() => setOpen((o) => !o)} title={current.desc}>
        {value === 'agent' ? <IconSparkle size={13} /> : <IconList size={13} />}
        <span>{current.label}</span>
        <IconChevronDown size={12} />
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} placement="top-start">
        <MenuList
          onClose={() => setOpen(false)}
          items={MODES.map((m) => ({ label: m.label, hint: m.desc, checked: m.id === value, onSelect: () => onChange(m.id) }))}
        />
      </Popover>
    </>
  )
}

function ModelPicker({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  const models = useStore((s) => s.models)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const label = models.find((m) => m.id === value)?.label ?? value

  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => search.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? models.filter((m) => m.id.toLowerCase().includes(s) || m.label.toLowerCase().includes(s)) : models
  }, [models, q])

  return (
    <>
      <button ref={btn} className={`pill ${open ? 'active' : ''}`} onClick={() => setOpen((o) => !o)} title={value}>
        <span className="pill-model">{label}</span>
        <IconChevronDown size={12} />
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} placement="top-start" className="model-popover">
        <div className="model-search">
          <input
            ref={search}
            placeholder="搜索模型"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered[0]) {
                onChange(filtered[0].id)
                setOpen(false)
                setQ('')
              }
            }}
          />
          <button
            className="icon-btn tiny"
            title="刷新模型列表"
            onClick={async () => {
              setRefreshing(true)
              await loadModels(true)
              setRefreshing(false)
            }}
          >
            <IconRefresh size={13} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
        <div className="model-list">
          {filtered.map((m) => (
            <button
              key={m.id}
              className={`menu-item ${m.id === value ? 'selected' : ''}`}
              onClick={() => {
                onChange(m.id)
                setOpen(false)
                setQ('')
              }}
            >
              <span className="menu-label">{m.label}</span>
              <span className="menu-hint mono">{m.id}</span>
            </button>
          ))}
          {filtered.length === 0 && <div className="empty-hint">无匹配模型</div>}
        </div>
      </Popover>
    </>
  )
}
