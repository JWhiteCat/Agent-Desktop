import { useT } from '../lib/i18n'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { argumentHint, filterCommands, slashQuery, type SlashCommand } from '@shared/commands'
import { cliTitle, type AgentMode, type CliProvider } from '@shared/types'
import { rememberModel, type SendOptions } from '../store'
import { IconArrowUp, IconBranch, IconChevronDown, IconFolder, IconList, IconShield, IconSparkle, IconStop } from './icons'
import { MenuList, Popover } from './Menu'
import { ModelPicker } from './ModelPicker'

export const MODES: { id: AgentMode; label: string; desc: string }[] = [
  { id: 'agent', label: 'Agent', desc: '可读写文件、执行命令' },
  { id: 'plan', label: 'Plan', desc: '只读分析，先给出方案' },
  { id: 'ask', label: 'Ask', desc: '只读问答，不做修改' }
]

const CLIS: { id: CliProvider; label: string; desc: string }[] = [
  { id: 'cursor', label: 'Cursor', desc: 'Cursor CLI' },
  { id: 'codex', label: 'Codex', desc: 'Codex CLI' },
  { id: 'claude', label: 'Claude', desc: 'Claude Code' }
]

export interface ComposerHandle {
  focus: () => void
  setText: (t: string) => void
  /** Sends `text` without touching the draft. `patch` also becomes the composer's new selection. */
  send: (text: string, patch?: Partial<SendOptions>) => Promise<void>
}

interface Props {
  projectId: string
  initial: SendOptions
  running?: boolean
  disabled?: boolean
  placeholder?: string
  showWorktree?: boolean
  cli?: CliProvider
  /** Return the model to select for `cli`. Called when the user picks a CLI in the composer. */
  onCliChange?: (cli: CliProvider) => string | void
  /** Shown on the CLI pill. While set with `cliDisabled`, the menu stays closed. */
  cliNote?: string
  cliDisabled?: boolean
  /** Slash commands offered when the draft is `/name`. */
  commands?: SlashCommand[]
  /** Called once when the user starts a `/` command, so the CLI list can be loaded. */
  onPrepare?: (opts: SendOptions) => void
  onForceChange?: (force: boolean) => void
  footerLeft?: React.ReactNode
  onSend: (text: string, opts: SendOptions) => Promise<void> | void
  onStop?: () => void
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(props, ref) {
  const t = useT()
  const { running, disabled } = props
  const [text, setText] = useState('')
  const [opts, setOpts] = useState<SendOptions>(props.initial)
  const [sending, setSending] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  const ta = useRef<HTMLTextAreaElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const slashArmed = useRef(false)
  const commands = props.commands ?? []
  const query = slashQuery(text)
  const matches = query === undefined ? [] : filterCommands(commands, query)
  const menuOpen = query !== undefined && !dismissed && matches.length > 0 && !disabled
  const hint = argumentHint(text, commands)

  useEffect(() => {
    setOpts((o) => (o.model === props.initial.model ? o : { ...o, model: props.initial.model }))
  }, [props.initial.model])

  useEffect(() => {
    const cli = props.initial.cli
    if (!cli) return
    setOpts((o) => (o.cli === cli ? o : { ...o, cli }))
  }, [props.initial.cli])

  useEffect(() => {
    setOpts((o) => (o.force === props.initial.force ? o : { ...o, force: props.initial.force }))
  }, [props.initial.force])

  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    setText: (t) => {
      setText(t)
      requestAnimationFrame(() => ta.current?.focus())
    },
    send: async (value, patch) => {
      if (running || disabled || sending) throw new Error(t('当前不能发送'))
      const next = patch ? { ...opts, ...patch } : opts
      if (patch) setOpts(next)
      setSending(true)
      try {
        await props.onSend(value, next)
      } finally {
        setSending(false)
      }
    }
  }))

  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  }, [text])

  useEffect(() => {
    setActive(0)
  }, [query])

  const highlighted = matches.length === 0 ? 0 : Math.min(active, matches.length - 1)

  useEffect(() => {
    if (!menuOpen) return
    listRef.current?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [menuOpen, highlighted])

  useEffect(() => {
    const armed = query !== undefined
    if (armed && !slashArmed.current) props.onPrepare?.(opts)
    slashArmed.current = armed
  }, [query, opts, props.onPrepare])

  const canSend = !!text.trim() && !running && !disabled && !sending
  const activeCli = opts.cli ?? props.cli

  const chooseCli = (next: CliProvider) => {
    if (next === activeCli) return
    const model = props.onCliChange?.(next)
    setOpts((o) => ({
      ...o,
      cli: next,
      model: typeof model === 'string' ? model : o.model
    }))
  }

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

  const choose = async (command: SlashCommand) => {
    setDismissed(true)
    if (command.hint) {
      setText(`/${command.name} `)
      requestAnimationFrame(() => ta.current?.focus())
      return
    }
    if (running || disabled || sending) return
    const value = `/${command.name}`
    setSending(true)
    setText('')
    try {
      await props.onSend(value, opts)
    } catch {
      setDismissed(false)
      setText(value)
    } finally {
      setSending(false)
    }
  }

  return (
    <div ref={box} className={`composer ${disabled ? 'disabled' : ''}`}>
      <textarea
        ref={ta}
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={props.placeholder ?? t('描述任务，Enter 发送，Shift+Enter 换行')}
        onChange={(e) => {
          setDismissed(false)
          setText(e.target.value)
        }}
        onKeyDown={(e) => {
          const composing = e.nativeEvent.isComposing || e.keyCode === 229
          if (!composing && menuOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setActive((i) => {
              const count = matches.length
              if (!count) return 0
              return e.key === 'ArrowDown' ? (i + 1) % count : (i - 1 + count) % count
            })
            return
          }
          if (!composing && menuOpen && (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
            e.preventDefault()
            const command = matches[highlighted]
            if (command) void choose(command)
            return
          }
          if (e.key === 'Escape' && menuOpen) {
            e.preventDefault()
            e.stopPropagation()
            setDismissed(true)
            return
          }
          if (e.key === 'Enter' && !e.shiftKey && !composing) {
            e.preventDefault()
            void submit()
          } else if (e.key === 'Escape' && running) {
            props.onStop?.()
          }
        }}
      />
      {hint && <div className="composer-hint">{hint}</div>}
      <Popover anchor={box.current} open={menuOpen} onClose={() => setDismissed(true)} placement="top-start" className="command-popover">
        <div ref={listRef} className="menu command-menu" role="listbox">
          {matches.map((command, i) => (
            <button
              key={`${command.local ? 'local' : 'cli'}:${command.name}`}
              type="button"
              role="option"
              aria-selected={i === highlighted}
              data-index={i}
              className={`menu-item ${i === highlighted ? 'active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => void choose(command)}
            >
              <span className="menu-label">/{command.name}</span>
              <span className="menu-hint">{command.local ? t(command.description) : command.description}</span>
            </button>
          ))}
        </div>
      </Popover>
      <div className="composer-bar">
        <div className="composer-left">
          {props.onCliChange && activeCli && (
            <CliPicker value={activeCli} note={props.cliNote} disabled={props.cliDisabled} onChange={chooseCli} />
          )}
          <ModePicker value={opts.mode} onChange={(mode) => setOpts((o) => ({ ...o, mode }))} />
          <ModelPicker
            cli={activeCli}
            value={opts.model}
            onChange={(model) => {
              setOpts((o) => ({ ...o, model }))
              rememberModel(props.projectId, model, opts.model, activeCli)
            }}
          />
          <button
            className={`pill ${opts.force ? 'pill-warn' : ''}`}
            title={opts.force ? t('完全访问：命令无需确认直接执行（--force）') : t('默认权限：遵循 CLI 权限配置')}
            onClick={() => {
              const force = !opts.force
              setOpts((o) => ({ ...o, force }))
              props.onForceChange?.(force)
            }}
          >
            <IconShield size={13} />
            <span>{opts.force ? t('完全访问') : t('默认权限')}</span>
          </button>
          {props.showWorktree && (
            <button
              className={`pill ${opts.worktree ? 'pill-on' : ''}`}
              title={t('在隔离的 git worktree 中运行')}
              onClick={() => setOpts((o) => ({ ...o, worktree: !o.worktree }))}
            >
              {opts.worktree ? <IconBranch size={13} /> : <IconFolder size={13} />}
              <span>{opts.worktree ? 'Worktree' : t('本地')}</span>
            </button>
          )}
          {props.footerLeft}
        </div>
        {running ? (
          <button className="send-btn stop" title={t('停止 (Esc)')} onClick={props.onStop}>
            <IconStop size={14} />
          </button>
        ) : (
          <button className="send-btn" title={t('发送 (Enter)')} disabled={!canSend} onClick={submit}>
            <IconArrowUp size={16} />
          </button>
        )}
      </div>
    </div>
  )
})

function CliPicker({
  value,
  note,
  disabled,
  onChange
}: {
  value: CliProvider
  note?: string
  disabled?: boolean
  onChange: (cli: CliProvider) => void
}) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={btn}
        className={`pill ${open ? 'active' : ''}`}
        disabled={disabled}
        title={note ?? `${cliTitle(value)} CLI`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{cliTitle(value)}</span>
        <IconChevronDown size={12} />
      </button>
      <Popover anchor={btn.current} open={open && !disabled} onClose={() => setOpen(false)} placement="top-start">
        <MenuList
          onClose={() => setOpen(false)}
          items={CLIS.map((cli) => ({
            label: cli.label,
            hint: cli.desc,
            checked: cli.id === value,
            onSelect: () => onChange(cli.id)
          }))}
        />
      </Popover>
    </>
  )
}

function ModePicker({ value, onChange }: { value: AgentMode; onChange: (m: AgentMode) => void }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const t = useT()
  const current = MODES.find((m) => m.id === value) ?? MODES[0]
  return (
    <>
      <button ref={btn} className={`pill ${open ? 'active' : ''}`} onClick={() => setOpen((o) => !o)} title={t(current.desc)}>
        {value === 'agent' ? <IconSparkle size={13} /> : <IconList size={13} />}
        <span>{t(current.label)}</span>
        <IconChevronDown size={12} />
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} placement="top-start">
        <MenuList
          onClose={() => setOpen(false)}
          items={MODES.map((m) => ({ label: t(m.label), hint: t(m.desc), checked: m.id === value, onSelect: () => onChange(m.id) }))}
        />
      </Popover>
    </>
  )
}

