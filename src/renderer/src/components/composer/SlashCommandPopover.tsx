import type { RefObject } from 'react'
import type { SlashCommand } from '@shared/commands'
import { useT } from '../../lib/i18n'
import { Popover } from '../Menu'

export function SlashCommandPopover({
  anchor,
  listRef,
  open,
  matches,
  highlighted,
  onClose,
  onHover,
  onSelect
}: {
  anchor: HTMLElement | null
  listRef: RefObject<HTMLDivElement | null>
  open: boolean
  matches: SlashCommand[]
  highlighted: number
  onClose: () => void
  onHover: (index: number) => void
  onSelect: (command: SlashCommand) => void
}) {
  const t = useT()
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="top-start" className="command-popover">
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
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(command)}
          >
            <span className="menu-label">/{command.name}</span>
            <span className="menu-hint">{command.local ? t(command.description) : command.description}</span>
          </button>
        ))}
      </div>
    </Popover>
  )
}
