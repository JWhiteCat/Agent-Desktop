import { useRef, useState } from 'react'
import { cliTitle, type AgentMode, type CliProvider } from '@shared/types'
import { useT } from '../../lib/i18n'
import { IconChevronDown, IconList, IconSparkle } from '../icons'
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
