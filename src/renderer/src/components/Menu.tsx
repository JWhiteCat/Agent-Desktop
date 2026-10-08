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
    const place = () => {
      const el = ref.current
      if (!el) return
      const a = anchor.getBoundingClientRect()
      const m = el.getBoundingClientRect()
      const gap = 6
      let top = placement.startsWith('top') ? a.top - m.height - gap : a.bottom + gap
      let left = placement.endsWith('end') ? a.right - m.width : a.left
      if (top + m.height > window.innerHeight - 8) top = Math.max(8, a.top - m.height - gap)
      if (top < 8) top = Math.min(a.bottom + gap, window.innerHeight - m.height - 8)
      left = Math.min(Math.max(8, left), window.innerWidth - m.width - 8)
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }))
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(ref.current)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
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

export function MenuList({ items, onClose, role }: { items: MenuEntry[]; onClose: () => void; role?: 'menu' }) {
  return (
    <div className="menu" role={role}>
      {items.map((it, i) =>
        it === 'separator' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            role={role ? 'menuitem' : undefined}
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

/** A pointer-positioned menu, also opened from a focused link with the keyboard. */
export function ContextMenu({ point, anchor, items, onClose }: {
  point: { x: number; y: number } | null
  anchor: HTMLElement | null
  items: MenuEntry[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const positioned = pos !== null
  const close = (restoreFocus = false) => {
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true })
    onClose()
  }

  useLayoutEffect(() => {
    if (!point || !ref.current) {
      setPos(null)
      return
    }
    const el = ref.current
    const place = () => {
      const rect = el.getBoundingClientRect()
      setPos({
        left: Math.min(Math.max(8, point.x), Math.max(8, window.innerWidth - rect.width - 8)),
        top: Math.min(Math.max(8, point.y), Math.max(8, window.innerHeight - rect.height - 8))
      })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(el)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [point])

  useLayoutEffect(() => {
    if (point && positioned) ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [point, positioned])

  useEffect(() => {
    if (!point) return
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (anchor?.isConnected) anchor.focus({ preventScroll: true })
        onClose()
      }
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('blur', onClose)
    }
  }, [point, anchor, onClose])

  if (!point) return null
  return createPortal(
    <div
      ref={ref}
      className="popover context-menu"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          close(true)
          return
        }
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        if (!buttons.length) return
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : event.key === 'ArrowDown' ? (current + 1) % buttons.length
            : event.key === 'ArrowUp' ? (current - 1 + buttons.length) % buttons.length : undefined
        if (next === undefined) return
        event.preventDefault()
        buttons[next].focus({ preventScroll: true })
      }}
    >
      <MenuList items={items} onClose={() => close(true)} role="menu" />
    </div>,
    document.body
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
