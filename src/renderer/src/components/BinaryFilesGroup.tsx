import type { ReactNode } from 'react'
import { useT } from '../lib/i18n'
import { IconChevronDown, IconChevronRight } from './icons'

export function BinaryFilesGroup({ count, open, onToggle, children }: {
  count: number
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const t = useT()
  if (!count) return null
  return (
    <div className="changes-binary-group">
      <button
        type="button"
        className="diff-file-head changes-binary-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        {t('二进制文件（{count}）', { count })}
      </button>
      {open && children}
    </div>
  )
}
