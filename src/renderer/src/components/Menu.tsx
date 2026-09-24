import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  icon?: React.ReactNode
  danger?: boolean
  checked?: boolean
  disabled?: boolean
  hint?: string
  onSelect: () => void
}

export type MenuEntry = MenuItem | 'separator'

interface PopoverProps {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  children: React.ReactNode
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
  className?: string
}

export function Popover({ anchor, open, onClose, children, placement = 'bottom-start', className }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) return
    const a = anchor.getBoundingClientRect()
    const m = ref.current.getBoundingClientRect()
    const gap = 6
    let top = placement.startsWith('top') ? a.top - m.height - gap : a.bottom + gap
    let left = placement.endsWith('end') ? a.right - m.width : a.left
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, a.top - m.height - gap)
    if (top < 8) top = Math.min(a.bottom + gap, window.innerHeight - m.height - 8)
    left = Math.min(Math.max(8, left), window.innerWidth - m.width - 8)
    setPos({ top, left })
  }, [open, anchor, placement])

  useEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [open, anchor, onClose])

  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      className={`popover ${className ?? ''}`}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    document.body
  )
}

export function MenuList({ items, onClose }: { items: MenuEntry[]; onClose: () => void }) {
  return (
    <div className="menu">
      {items.map((it, i) =>
        it === 'separator' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={`menu-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.onSelect()
            }}
          >
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
            {it.checked && <span className="menu-check">✓</span>}
          </button>
        )
      )}
    </div>
  )
}

/** Button that toggles a dropdown menu. */
export function MenuButton({
  items,
  children,
  className,
  title,
  placement
}: {
  items: MenuEntry[] | (() => MenuEntry[])
  children: React.ReactNode
  className?: string
  title?: string
  placement?: PopoverProps['placement']
}) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={btn}
        className={`${className ?? 'icon-btn'} ${open ? 'active' : ''}`}
        title={title}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        {children}
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} placement={placement}>
        <MenuList items={typeof items === 'function' ? items() : items} onClose={() => setOpen(false)} />
      </Popover>
    </>
  )
}
