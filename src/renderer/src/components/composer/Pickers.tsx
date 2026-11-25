import { useEffect, useRef, useState } from 'react'
import { cliTitle, type AgentMode, type CliProvider } from '@shared/types'
import { useT } from '../../lib/i18n'
import { IconChevronDown, IconList, IconSliders, IconSparkle } from '../icons'
import { MenuList, Popover } from '../Menu'

export const MODES: { id: AgentMode; label: string; desc: string }[] = [
  { id: 'agent', label: 'Agent', desc: '可读写文件、执行命令' },
  { id: 'plan', label: 'Plan', desc: '只读分析，先给出方案' },
  { id: 'ask', label: 'Ask', desc: '只读问答，不做修改' }
]

const CLIS: { id: CliProvider; label: string; desc: string }[] = [
  { id: 'cursor', label: 'Cursor', desc: 'Cursor CLI' },
  { id: 'codex', label: 'Codex', desc: 'Codex CLI' },
  { id: 'claude', label: 'Claude', desc: 'Claude Code' },
  { id: 'antigravity', label: 'Antigravity', desc: 'Antigravity CLI' }
]

export function CliPicker({
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
        className={`pill cli-pill ${open ? 'active' : ''}`}
        data-cli={value}
        disabled={disabled}
        title={note ?? `${cliTitle(value)} CLI`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cli-dot" data-cli={value} aria-hidden="true" />
        <span>{cliTitle(value)}</span>
        <IconChevronDown size={12} />
      </button>
      <Popover anchor={btn.current} open={open && !disabled} onClose={() => setOpen(false)} placement="top-start">
        <MenuList
          onClose={() => setOpen(false)}
          items={CLIS.map((cli) => ({
            label: cli.label,
            hint: cli.desc,
            icon: <span className="cli-dot" data-cli={cli.id} aria-hidden="true" />,
            checked: cli.id === value,
            onSelect: () => onChange(cli.id)
          }))}
        />
      </Popover>
    </>
  )
}

export function ModePicker({ value, onChange }: { value: AgentMode; onChange: (m: AgentMode) => void }) {
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

export interface ComposerOptionsProps {
  cli?: CliProvider
  cliNote?: string
  cliDisabled?: boolean
  onCliChange?: (cli: CliProvider) => void
  mode: AgentMode
  onModeChange: (mode: AgentMode) => void
  force: boolean
  onForceChange: (force: boolean) => void
  showWorktree?: boolean
  worktree?: boolean
  onWorktreeChange?: (worktree: boolean) => void
}

const NARROW_MEDIA = '(max-width: 720px)'

export function ComposerOptionsPanel({
  cli,
  cliNote,
  cliDisabled,
  onCliChange,
  mode,
  onModeChange,
  force,
  onForceChange,
  showWorktree,
  worktree,
  onWorktreeChange
}: ComposerOptionsProps) {
  const t = useT()
  return (
    <div className="composer-options-panel">
      {cli && onCliChange && (
        <div className="model-param">
          <div className="model-param-label">CLI</div>
          <div className="composer-options-col">
            <div className="model-param-options">
              {CLIS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`model-opt ${item.id === cli ? 'selected' : ''}`}
                  disabled={cliDisabled}
                  aria-pressed={item.id === cli}
                  onClick={() => onCliChange(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {cliDisabled && cliNote && <div className="composer-options-note">{cliNote}</div>}
          </div>
        </div>
      )}
      <div className="model-param">
        <div className="model-param-label">{t('模式')}</div>
        <div className="model-param-options">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`model-opt ${m.id === mode ? 'selected' : ''}`}
              title={t(m.desc)}
              aria-pressed={m.id === mode}
              onClick={() => onModeChange(m.id)}
            >
              {t(m.label)}
            </button>
          ))}
        </div>
      </div>
      <div className="model-param">
        <div className="model-param-label">{t('权限')}</div>
        <div className="model-param-options">
          <button
            type="button"
            className={`model-opt ${!force ? 'selected' : ''}`}
            title={t('默认权限：遵循 CLI 权限配置')}
            aria-pressed={!force}
            onClick={() => {
              if (force) onForceChange(false)
            }}
          >
            {t('默认权限')}
          </button>
          <button
            type="button"
            className={`model-opt ${force ? 'selected warn' : ''}`}
            title={t('完全访问：命令无需确认直接执行（--force）')}
            aria-pressed={force}
            onClick={() => {
              if (!force) onForceChange(true)
            }}
          >
            {t('完全访问')}
          </button>
        </div>
      </div>
      {showWorktree && onWorktreeChange && (
        <div className="model-param">
          <div className="model-param-label">{t('工作区')}</div>
          <div className="model-param-options">
            <button
              type="button"
              className={`model-opt ${!worktree ? 'selected' : ''}`}
              aria-pressed={!worktree}
              onClick={() => {
                if (worktree) onWorktreeChange(false)
              }}
            >
              {t('本地')}
            </button>
            <button
              type="button"
              className={`model-opt ${worktree ? 'selected' : ''}`}
              title={t('在隔离的 git worktree 中运行')}
              aria-pressed={!!worktree}
              onClick={() => {
                if (!worktree) onWorktreeChange(true)
              }}
            >
              Worktree
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function ComposerOptionsButton(props: ComposerOptionsProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(NARROW_MEDIA)
    const onChange = (e: MediaQueryListEvent) => {
      if (!e.matches) setOpen(false)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [open])

  const currentMode = MODES.find((m) => m.id === props.mode) ?? MODES[0]
  const dotTone = props.force ? 'warn' : props.mode !== 'agent' || (props.showWorktree && props.worktree) ? 'active' : undefined
  const summary = [
    t('对话选项'),
    props.cli ? cliTitle(props.cli) : undefined,
    t(currentMode.label),
    props.force ? t('完全访问') : t('默认权限'),
    props.showWorktree ? (props.worktree ? 'Worktree' : t('本地')) : undefined
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`icon-btn composer-options-btn ${open ? 'active' : ''}`}
        title={summary}
        aria-label={summary}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IconSliders size={16} />
        {dotTone && <span className={`composer-options-dot ${dotTone}`} aria-hidden />}
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} placement="top-end" className="composer-options-popover">
        <ComposerOptionsPanel {...props} />
      </Popover>
    </>
  )
}
