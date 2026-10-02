import { useEffect, useState } from 'react'
import { getLocale } from '@shared/i18n'
import { displayQuotaText, type CodexResetCredit, type ProviderQuota, type QuotaReport, type QuotaWindow, type WindowUsage } from '@shared/quota'
import { useT } from '../../lib/i18n'
import { compactNumber, formatUsd, localExpiry, resetStamp, resetsIn } from '../../lib/format'
import { errorText } from '../../store'
import { HoverTip } from '../HoverTip'

export function QuotaPanel() {
  const t = useT()
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
  }, [reload, t])

  return (
    <>
      <div className="quota-head">
        <h4>{t('额度')}</h4>
        <button type="button" className="usage-period" disabled={loading} onClick={() => setReload((n) => n + 1)}>
          {t('刷新')}
        </button>
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      {!report && loading ? (
        <div className="muted small">{t('正在读取额度…')}</div>
      ) : report ? (
        <div className="quota-grid">
          <QuotaCard title="Cursor" quota={report.cursor} />
          <QuotaCard title="Codex" quota={report.codex} onRedeemed={() => setReload((n) => n + 1)} />
        </div>
      ) : null}
    </>
  )
}

function QuotaCard({ title, quota, onRedeemed }: { title: string; quota: ProviderQuota; onRedeemed?: () => void }) {
  const t = useT()
  const plan = planCaption(quota.plan)
  return (
    <div className="quota-card">
      <div className="quota-card-title">
        <span>{title}</span>
        {plan ? <span className="muted">{plan}</span> : null}
      </div>
      {quota.windows.length === 0 ? (
        <div className="muted small">{quota.note ? displayQuotaText(quota.note) : t('没有额度数据')}</div>
      ) : (
        quota.windows.map((row) => <QuotaRow key={row.id} row={row} />)
      )}
      {quota.resetCredits !== undefined ? <ResetCredits credits={quota.resetCredits} onRedeemed={onRedeemed} /> : null}
    </div>
  )
}

function ResetCredits({ credits, onRedeemed }: { credits: CodexResetCredit[] | null; onRedeemed?: () => void }) {
  const t = useT()
  const [pendingId, setPendingId] = useState('')
  const [error, setError] = useState('')

  async function redeem(credit: CodexResetCredit): Promise<void> {
    if (pendingId) return
    const title = credit.title || t('重置卡')
    if (!window.confirm(t('使用重置卡「{title}」？此操作会用掉这张卡，且不能撤销。', { title }))) return
    setPendingId(credit.id)
    setError('')
    try {
      await window.api.consumeCodexReset(credit.id)
      onRedeemed?.()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setPendingId('')
    }
  }

  return (
    <div className="quota-resets">
      <div className="quota-row-top">
        <span>{t('重置卡')}</span>
      </div>
      {credits == null ? (
        <div className="muted small">{t('暂时无法读取重置卡')}</div>
      ) : credits.length === 0 ? (
        <div className="muted small">{t('没有重置卡')}</div>
      ) : (
        credits.map((credit) => {
          const title = credit.title || t('重置卡')
          const expiry = credit.expiresAt != null ? t('到期 {date}', { date: localExpiry(credit.expiresAt) }) : t('没有到期时间')
          return (
            <div className="quota-reset" key={credit.id}>
              <div className="quota-reset-top">
                <span>{title}{credit.status ? ` · ${resetStatus(credit.status)}` : ''}</span>
                {credit.status === 'available' ? (
                  <button type="button" className="usage-period" disabled={pendingId !== ''} onClick={() => void redeem(credit)}>
                    {t('重置')}
                  </button>
                ) : null}
              </div>
              <div className="muted small">{expiry}</div>
            </div>
          )
        })
      )}
      {error ? <div className="notice error">{error}</div> : null}
    </div>
  )
}

function resetStatus(status: string): string {
  if (status === 'available') return displayQuotaText('可用')
  if (status === 'redeemed') return displayQuotaText('已使用')
  if (status === 'expired') return displayQuotaText('已过期')
  return status
}

function QuotaRow({ row }: { row: QuotaWindow }) {
  const t = useT()
  const name = row.detail ? `${displayQuotaText(row.label)} · ${displayQuotaText(row.detail)}` : displayQuotaText(row.label)
  const used = row.usedPercent
  const reset = row.resetsAt != null ? t('下次重置 {date}（{relative}）', { date: resetStamp(row.resetsAt), relative: resetsIn(row.resetsAt) }) : ''
  return (
    <div className="quota-row">
      <div className="quota-row-top">
        <span>{name}</span>
        <span className="muted">
          {used != null ? t('已用 {used} · 剩余 {remaining}', { used: formatPercent(used), remaining: formatPercent(Math.max(0, 100 - used)) }) : ''}
          {used != null && row.amount ? ' · ' : ''}
          {row.amount ? displayQuotaText(row.amount) : ''}
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
  const t = useT()
  const price = hidePrice ? '' : usage.costUsd == null ? t('未定价') : t('总价 {price}', { price: formatUsd(usage.costUsd) })
  if (!usage.tokensKnown) return price ? <div className="muted small">{price}</div> : null
  return (
    <div className="muted small">
      {t('输入')} <TokenCount n={usage.inputTokens} /> · {t('输出')} <TokenCount n={usage.outputTokens} /> · {t('缓存读')} <TokenCount n={usage.cacheReadTokens} /> · {t('缓存写')}{' '}
      <TokenCount n={usage.cacheWriteTokens} />
      {price ? ` · ${price}` : ''}
    </div>
  )
}

function TokenCount({ n }: { n: number }) {
  useT()
  return <HoverTip text={n.toLocaleString(getLocale())}>{compactNumber(n)}</HoverTip>
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
