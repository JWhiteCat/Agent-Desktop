import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { BuiltinToolbarAction, ToolbarButton } from '@shared/types'
import { normalizeToolbarButtons } from '@shared/toolbar'
import { useT } from '../lib/i18n'
import { shortPath } from '../lib/format'
import { shortcutHint } from '../lib/shortcut'
import { errorText, toast } from '../store'
import { MenuButton, type MenuEntry } from './Menu'
import { IconBranch, IconCursor, IconDiff, IconFolder, IconMore, IconTerminal, IconVSCode, Spinner } from './icons'

interface Props {
  buttons: ToolbarButton[]
  threadId: string
  cwd: string
  modelLabel?: string
  canFork: boolean
  onFork: () => void
  changesOpen: boolean
  onToggleChanges: () => void
}

/** Keep a prefix of the configured order, reserving space for More when needed. */
export function toolbarVisibleCount(widths: readonly number[], available: number, moreWidth = 32, gap = 2): number {
  const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap
  if (total <= available) return widths.length
  let used = moreWidth
  let count = 0
  for (const width of widths) {
    if (used + width + gap > available) break
    used += width + gap
    count++
  }
  return count
}

/** Hidden or not-yet-laid-out elements must not replace a usable toolbar width with zero. */
export function measureToolbarLayout(widths: readonly number[], available: number): { count: number; width: number } | null {
  if (!widths.length || !(available > 0) || !Number.isFinite(available) || widths.some((width) => !(width > 0) || !Number.isFinite(width))) return null
  const width = widths.reduce((sum, value) => sum + value, 0) + Math.max(0, widths.length - 1) * 2
  return { count: toolbarVisibleCount(widths, available), width }
}

const ICONS: Record<BuiltinToolbarAction, ReactNode> = {
  fork: <IconBranch />, files: <IconFolder />, vscode: <IconVSCode />, cursor: <IconCursor />, changes: <IconDiff />
}

export function ThreadToolbar({ buttons, threadId, cwd, modelLabel, canFork, onFork, changesOpen, onToggleChanges }: Props) {
  const t = useT()
  const remote = window.api.isRemote
  const configured = useMemo(() => normalizeToolbarButtons(buttons).filter((button) => button.visible &&
    (!remote || (button.kind === 'builtin' && (button.action === 'fork' || button.action === 'changes')))), [buttons, remote])
  const actions = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLDivElement>(null)
  const starting = useRef(new Set<string>())
  const [pending, setPending] = useState(new Set<string>())
  const [layout, setLayout] = useState<{ count: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const element = actions.current
    const measurements = measure.current
    if (!element || !measurements) return
    let lastWidths: number[] = []
    const update = () => {
      const widths = Array.from(measurements.children, (child) => child.getBoundingClientRect().width)
      const available = element.getBoundingClientRect().width
      const measured = measureToolbarLayout(widths, available)
      if (measured) lastWidths = widths
      const next = measured ?? measureToolbarLayout(lastWidths, available)
      if (next) setLayout((previous) => previous?.count === next.count && previous.width === next.width ? previous : next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    observer.observe(measurements)
    return () => observer.disconnect()
  }, [configured, t])

  const label = (button: ToolbarButton): string => {
    if (button.kind === 'command') return button.name
    switch (button.action) {
      case 'fork': return t('分叉对话（/fork）')
      case 'files': return t('在文件管理器中打开 {path}', { path: shortPath(cwd) })
      case 'vscode': return t('在 VS Code 中打开')
      case 'cursor': return t('在 Cursor 中打开')
      case 'changes': return shortcutHint(t('变更面板 (Ctrl+Shift+D)'))
    }
  }
  const disabled = (button: ToolbarButton) => button.kind === 'command' ? pending.has(button.id) || !cwd
    : button.action === 'fork' ? !canFork : button.action === 'changes' ? false : !cwd
  const icon = (button: ToolbarButton) => button.kind === 'builtin' ? ICONS[button.action]
    : pending.has(button.id) ? <Spinner size={16} /> : <IconTerminal />
  const invoke = async (button: ToolbarButton) => {
    try {
      if (button.kind === 'command') {
        if (starting.current.has(button.id)) return
        starting.current.add(button.id)
        setPending(new Set(starting.current))
        try { await window.api.runToolbarCommand(button.id, threadId) }
        finally {
          starting.current.delete(button.id)
          setPending(new Set(starting.current))
        }
      } else {
        switch (button.action) {
          case 'fork': onFork(); break
          case 'files': await window.api.openPath(cwd); break
          case 'vscode': await window.api.openInEditor(cwd, 'vscode'); break
          case 'cursor': await window.api.openInEditor(cwd, 'cursor'); break
          case 'changes': onToggleChanges(); break
        }
      }
    } catch (error) { toast(errorText(error), 'error') }
  }
  const renderButton = (button: ToolbarButton, measuring = false) => (
    <button
      key={button.id}
      type="button"
      className={`icon-btn thread-toolbar-button ${button.kind === 'command' ? 'thread-toolbar-command' : ''} ${button.kind === 'builtin' && button.action === 'changes' && changesOpen ? 'active' : ''}`}
      title={measuring ? undefined : label(button)}
      aria-label={measuring ? undefined : label(button)}
      aria-pressed={!measuring && button.kind === 'builtin' && button.action === 'changes' ? changesOpen : undefined}
      disabled={disabled(button)}
      tabIndex={measuring ? -1 : undefined}
      onClick={measuring ? undefined : () => void invoke(button)}
    >
      {icon(button)}
      {button.kind === 'command' && <span>{button.name}</span>}
    </button>
  )
  const count = Math.min(layout?.count ?? configured.length, configured.length)
  const overflow: MenuEntry[] = configured.slice(count).map((button) => ({
    label: label(button), icon: icon(button), disabled: disabled(button),
    checked: button.kind === 'builtin' && button.action === 'changes' && changesOpen,
    onSelect: () => void invoke(button)
  }))

  return (
    <div className={`header-actions thread-toolbar no-drag${configured.length ? ' thread-toolbar-has-actions' : ''}`}>
      {modelLabel && <span className="muted small model-label" title={modelLabel}>{modelLabel}</span>}
      {configured.length > 0 && <div className="thread-toolbar-actions" ref={actions} style={{ width: layout?.width }}>
        {configured.slice(0, count).map((button) => renderButton(button))}
        {overflow.length > 0 && <MenuButton items={overflow} title={t('更多顶部操作')} placement="bottom-end"><IconMore /></MenuButton>}
        <div className="thread-toolbar-measure" ref={measure} aria-hidden="true">
          {configured.map((button) => renderButton(button, true))}
        </div>
      </div>}
    </div>
  )
}
