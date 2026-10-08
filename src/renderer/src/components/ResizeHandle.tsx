import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { PANEL_LIMITS, type PanelId } from '@shared/panel-widths'
import { panelLayout } from '../lib/panel-layout'
import { useT } from '../lib/i18n'

const KEY_STEP = 16
const KEY_STEP_LARGE = 64
const KEY_SAVE_DELAY = 500

interface Drag {
  pointer: number
  startX: number
  start: number
  x: number
  frame: number
}

/** Drag handle on a panel's inner edge. Double-click restores the default width; arrow keys resize. */
export function ResizeHandle({ panel, label }: { panel: PanelId; label: string }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const limit = PANEL_LIMITS[panel]
  const [width, setWidth] = useState(() => panelLayout().width(panel))

  useLayoutEffect(() => {
    const layout = panelLayout()
    layout.show(panel)
    setWidth(layout.width(panel))
    const off = layout.subscribe(() => {
      if (!drag.current) setWidth(layout.width(panel))
    })
    return () => {
      off()
      layout.hide(panel)
    }
  }, [panel])

  useEffect(
    () => () => {
      if (saveTimer.current === undefined) return
      clearTimeout(saveTimer.current)
      panelLayout().save()
    },
    []
  )

  const applyDrag = () => {
    const d = drag.current
    if (!d) return
    d.frame = 0
    const shown = panelLayout().resize(panel, d.start + limit.dir * (d.x - d.startX))
    ref.current?.setAttribute('aria-valuenow', String(shown))
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { pointer: e.pointerId, startX: e.clientX, x: e.clientX, start: panelLayout().beginDrag(panel), frame: 0 }
    e.currentTarget.classList.add('active')
    document.body.classList.add('panel-resizing')
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointer !== e.pointerId) return
    d.x = e.clientX
    if (!d.frame) d.frame = requestAnimationFrame(applyDrag)
  }

  const finish = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointer !== e.pointerId) return
    if (d.frame) cancelAnimationFrame(d.frame)
    applyDrag()
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    e.currentTarget.classList.remove('active')
    document.body.classList.remove('panel-resizing')
    const layout = panelLayout()
    layout.endDrag(d.x !== d.startX)
    setWidth(layout.width(panel))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const layout = panelLayout()
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    const current = layout.width(panel)
    const next =
      e.key === 'ArrowLeft' ? current - step * limit.dir
      : e.key === 'ArrowRight' ? current + step * limit.dir
      : e.key === 'Home' ? limit.min
      : e.key === 'End' ? limit.max
      : undefined
    if (next === undefined) return
    e.preventDefault()
    setWidth(layout.resize(panel, next))
    if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined
      layout.save()
    }, KEY_SAVE_DELAY)
  }

  return (
    <div
      ref={ref}
      className={`resize-handle no-drag ${limit.dir === 1 ? 'edge-right' : 'edge-left'}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={limit.min}
      aria-valuemax={limit.max}
      tabIndex={0}
      title={t('拖动调整宽度，双击恢复默认宽度')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => setWidth(panelLayout().reset(panel))}
      onKeyDown={onKeyDown}
    />
  )
}
