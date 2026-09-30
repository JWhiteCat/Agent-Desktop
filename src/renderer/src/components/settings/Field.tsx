import type { ReactNode } from 'react'
import { useT } from '../../lib/i18n'

export function Field({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  const t = useT()
  return (
    <div className="field">
      <div className="field-label">
        <div>{t(label)}</div>
        {desc && <div className="muted small">{t(desc)}</div>}
      </div>
      <div className="field-control">{children}</div>
    </div>
  )
}
