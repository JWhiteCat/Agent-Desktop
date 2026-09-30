import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Hover detail that stays up while the pointer is over the trigger.
 * Native `title` tooltips are dismissed by any keydown; this one is not.
 */
export function HoverTip({ text, children }: { text?: string; children: React.ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const anchorEl = anchor.current
    const bubbleEl = bubble.current
    if (!anchorEl || !bubbleEl) return
    const place = () => {
      const a = anchorEl.getBoundingClientRect()
      const b = bubbleEl.getBoundingClientRect()
      const gap = 8
      let top = a.top - b.height - gap
      if (top < 8) top = Math.min(a.bottom + gap, Math.max(8, window.innerHeight - b.height - 8))
      let left = a.left + a.width / 2 - b.width / 2
      left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - b.width - 8))
      const next = { top: Math.round(top), left: Math.round(left) }
      setPos((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next))
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(bubbleEl)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, text])

  if (!text) return <>{children}</>
  return (
    <span ref={anchor} className="hover-tip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span className="hover-tip-label">{children}</span>
      <span className="hover-tip-copy">{text}</span>
      {open &&
        createPortal(
          <div
            ref={bubble}
            className="hover-tip-bubble"
            role="tooltip"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
          >
            {text}
          </div>,
          document.body
        )}
    </span>
  )
}
