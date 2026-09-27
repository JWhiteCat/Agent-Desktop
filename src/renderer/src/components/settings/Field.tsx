import type { ReactNode } from 'react'

export function Field({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">
        <div>{label}</div>
        {desc && <div className="muted small">{desc}</div>}
      </div>
      <div className="field-control">{children}</div>
    </div>
  )
}
