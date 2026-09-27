import { useEffect, type ReactNode } from 'react'
import { IconX } from './icons'

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  nav
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  nav?: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''} ${nav ? 'with-nav' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose}>
            <IconX size={14} />
          </button>
        </div>
        {nav ? (
          <div className="modal-split">
            {nav}
            <div className="modal-body">{children}</div>
          </div>
        ) : (
          <div className="modal-body">{children}</div>
        )}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
