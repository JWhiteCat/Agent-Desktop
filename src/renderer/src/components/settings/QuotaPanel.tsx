import { useEffect, useState } from 'react'
import type { ProviderQuota, QuotaReport, QuotaWindow, WindowUsage } from '@shared/quota'
import { compactNumber, formatUsd, resetStamp, resetsIn } from '../../lib/format'
import { errorText } from '../../store'

export function QuotaPanel() {
  const [report, setReport] = useState<QuotaReport | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancel = false
    setLoading(true)
    window.api.usageQuotas().then(
      (next) => {
        if (cancel) return
        setReport(next)
        setError('')
        setLoading(false)
      },
      (err) => {
        if (cancel) return
        setError(errorText(err))
        setLoading(false)
      }
    )
    return () => {
      cancel = true
    }
  }, [reload])

  return (
    <>
      <div className="quota-head">
        <h4>额度</h4>
        <button type="button" className="usage-period" disabled={loading} onClick={() => setReload((n) => n + 1)}>
          刷新
        </button>
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      {!report && loading ? (
        <div className="muted small">正在读取额度…</div>
      ) : report ? (
        <div className="quota-grid">
          <QuotaCard title="Cursor" quota={report.cursor} />
          <QuotaCard title="Codex" quota={report.codex} />
        </div>
      ) : null}
    </>
  )
}

function QuotaCard({ title, quota }: { title: string; quota: ProviderQuota }) {
  const plan = planCaption(quota.plan)
  return (
    <div className="quota-card">
      <div className="quota-card-title">
        <span>{title}</span>
        {plan ? <span className="muted">{plan}</span> : null}
      </div>
      {quota.windows.length === 0 ? (
        <div className="muted small">{quota.note || '没有额度数据'}</div>
      ) : (
        quota.windows.map((row) => <QuotaRow key={row.id} row={row} />)
      )}
    </div>
  )
}

function QuotaRow({ row }: { row: QuotaWindow }) {
  const name = row.detail ? `${row.label} · ${row.detail}` : row.label
  const used = row.usedPercent
  const reset = row.resetsAt != null ? `下次重置 ${resetStamp(row.resetsAt)}（${resetsIn(row.resetsAt)}）` : ''
  return (
    <div className="quota-row">
      <div className="quota-row-top">
        <span>{name}</span>
        <span className="muted">
          {used != null ? `已用 ${formatPercent(used)} · 剩余 ${formatPercent(Math.max(0, 100 - used))}` : ''}
          {used != null && row.amount ? ' · ' : ''}
          {row.amount ?? ''}
        </span>
      </div>
      {used != null ? (
        <div className="quota-bar" aria-hidden="true">
          <div className={barClass(used)} style={{ width: `${Math.max(0, Math.min(100, used))}%` }} />
        </div>
      ) : null}
      {row.usage ? <WindowUsageLine usage={row.usage} hidePrice={row.id === 'on-demand' || row.id === 'on-demand-pooled'} /> : null}
      {reset ? <div className="muted small">{reset}</div> : null}
    </div>
  )
}

function WindowUsageLine({ usage, hidePrice }: { usage: WindowUsage; hidePrice?: boolean }) {
  const price = hidePrice ? '' : usage.costUsd == null ? '未定价' : `总价 ${formatUsd(usage.costUsd)}`
  if (!usage.tokensKnown) return price ? <div className="muted small">{price}</div> : null
  return (
    <div className="muted small">
      输入 <TokenCount n={usage.inputTokens} /> · 输出 <TokenCount n={usage.outputTokens} /> · 缓存读 <TokenCount n={usage.cacheReadTokens} /> · 缓存写{' '}
      <TokenCount n={usage.cacheWriteTokens} />
      {price ? ` · ${price}` : ''}
    </div>
  )
}

function TokenCount({ n }: { n: number }) {
  return <span title={n.toLocaleString('zh-CN')}>{compactNumber(n)}</span>
}

function planCaption(plan?: string): string {
  const text = plan?.trim() ?? ''
  if (!text) return ''
  if (text === text.toLowerCase()) return text.charAt(0).toUpperCase() + text.slice(1)
  return text
}

function formatPercent(n: number): string {
  const rounded = Math.round(n * 10) / 10
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`
}

function barClass(used: number): string {
  if (used >= 100) return 'quota-bar-fill full'
  if (used >= 80) return 'quota-bar-fill high'
  return 'quota-bar-fill'
}
