import { useEffect, useMemo, useState } from 'react'
import { getLocale } from '@shared/i18n'
import type { UsageSessionRow, UsageSummary, UsageWindow } from '@shared/usage'
import type { CliProvider } from '@shared/types'
import { useT } from '../../lib/i18n'
import { displayThreadTitle } from '@shared/thread-title'
import { compactNumber, formatUsd, relativeTime } from '../../lib/format'
import { groupModels, modelCaption } from '../../lib/models'
import { errorText, useStore } from '../../store'
import { HoverTip } from '../HoverTip'
import { Hyperlink } from '../Hyperlink'
import { QuotaPanel } from './QuotaPanel'

const USAGE_PERIODS: { id: UsageWindow; label: string }[] = [
  { id: '1d', label: '1天' },
  { id: '7d', label: '7天' },
  { id: '30d', label: '30天' }
]

const USAGE_PAGE_SIZE = 20

const PRICE_SOURCES: Record<CliProvider, { label: string; href: string }[]> = {
  cursor: [{ label: 'Cursor 公开标价', href: 'https://cursor.com/docs/models-and-pricing' }],
  codex: [{ label: 'OpenAI API 价格', href: 'https://developers.openai.com/api/docs/pricing' }],
  claude: [{ label: 'Anthropic API 价格', href: 'https://platform.claude.com/docs/en/about-claude/pricing' }],
  antigravity: [
    { label: 'Gemini API 价格', href: 'https://ai.google.dev/gemini-api/docs/pricing' },
    { label: 'Google Cloud 合作伙伴模型价格', href: 'https://cloud.google.com/model-garden/partner-models/pricing' }
  ]
}

type SummaryResult =
  | { period: UsageWindow; summary: UsageSummary }
  | { period: UsageWindow; error: string }

function UsageToken({ n }: { n: number }) {
  useT()
  return <HoverTip text={n.toLocaleString(getLocale())}>{compactNumber(n)}</HoverTip>
}

export function UsageSettings({ provider, period, onPeriodChange }: {
  provider: CliProvider
  period: UsageWindow
  onPeriodChange: (period: UsageWindow) => void
}) {
  const t = useT()
  const models = useStore((s) => s.modelsByCli[provider])
  const groups = useMemo(() => groupModels(models), [models])
  const [result, setResult] = useState<SummaryResult | null>(null)
  const [sessions, setSessions] = useState<UsageSessionRow[] | null>(null)
  const [page, setPage] = useState(1)
  const modelName = (id: string, fallback: string) => id ? modelCaption(groups, id, provider) : t(fallback)

  useEffect(() => {
    let cancel = false
    window.api.usageSummary(period, provider).then(
      (report) => {
        if (cancel) return
        setResult({ period, summary: report.summary })
        setSessions(report.sessions)
      },
      (err) => {
        if (!cancel) setResult({ period, error: errorText(err) })
      }
    )
    return () => {
      cancel = true
    }
  }, [period, provider, t])

  const current = result?.period === period ? result : null
  const summary = current && 'summary' in current ? current.summary : null
  const error = current && 'error' in current ? current.error : ''
  const pageCount = Math.max(1, Math.ceil((sessions?.length ?? 0) / USAGE_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const visibleSessions = sessions?.slice((currentPage - 1) * USAGE_PAGE_SIZE, currentPage * USAGE_PAGE_SIZE) ?? []

  return (
    <>
      {(provider === 'cursor' || provider === 'codex' || provider === 'antigravity') && <QuotaPanel provider={provider} />}
      <h4>{t('本机用量')}</h4>
      <div className="usage-periods" role="group" aria-label={t('统计范围')}>
        {USAGE_PERIODS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`usage-period ${period === item.id ? 'active' : ''}`}
            aria-pressed={period === item.id}
            onClick={() => onPeriodChange(item.id)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      {error ? (
        <div className="notice error">{error}</div>
      ) : !summary ? (
        <div className="muted small">{t('正在统计…')}</div>
      ) : summary.turns === 0 ? (
        <div className="muted small">{t('这段时间没有用量')}</div>
      ) : (
        <>
          <div className="usage-stats">
            <div className="usage-stat">
              <div className="label">{t('费用')}</div>
              <div className="value">{formatUsd(summary.costUsd)}</div>
            </div>
            <div className="usage-stat">
              <div className="label">{t('回合')}</div>
              <div className="value">{summary.turns}</div>
            </div>
            <div className="usage-stat">
              <div className="label">{t('输入')}</div>
              <div className="value">
                <UsageToken n={summary.inputTokens} />
              </div>
            </div>
            <div className="usage-stat">
              <div className="label">{t('输出')}</div>
              <div className="value">
                <UsageToken n={summary.outputTokens} />
              </div>
            </div>
            <div className="usage-stat">
              <div className="label">{t('缓存读')}</div>
              <div className="value">
                <UsageToken n={summary.cacheReadTokens} />
              </div>
            </div>
            <div className="usage-stat">
              <div className="label">{t('缓存写')}</div>
              <div className="value">
                <UsageToken n={summary.cacheWriteTokens} />
              </div>
            </div>
          </div>
          {summary.unpricedTurns > 0 && summary.costUsd != null && (
            <div className="muted small">{t('另有 {count} 轮未定价，未计入费用。', { count: summary.unpricedTurns })}</div>
          )}
          <div className="usage-table-wrap">
            <table className="usage-table">
              <thead>
                <tr>
                  <th>{t('模型')}</th>
                  <th>{t('回合')}</th>
                  <th>{t('输入')}</th>
                  <th>{t('输出')}</th>
                  <th>{t('缓存读')}</th>
                  <th>{t('缓存写')}</th>
                  <th>{t('费用')}</th>
                </tr>
              </thead>
              <tbody>
                {summary.models.map((row) => (
                  <tr key={`${row.cli}\n${row.model}\n${row.label}`}>
                    <td>{modelName(row.model, row.label)}</td>
                    <td>{row.turns}</td>
                    <td>
                      <UsageToken n={row.inputTokens} />
                    </td>
                    <td>
                      <UsageToken n={row.outputTokens} />
                    </td>
                    <td>
                      <UsageToken n={row.cacheReadTokens} />
                    </td>
                    <td>
                      <UsageToken n={row.cacheWriteTokens} />
                    </td>
                    <td>{formatUsd(row.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h4>{t('会话')}</h4>
      {sessions == null ? (
        error ? null : <div className="muted small">{t('正在统计…')}</div>
      ) : sessions.length === 0 ? (
        <div className="muted small">{t('还没有历史会话')}</div>
      ) : (
        <>
          <div className="usage-table-wrap">
            <table className="usage-table">
              <thead>
                <tr>
                  <th>{t('会话')}</th>
                  <th className="usage-model">{t('模型')}</th>
                  <th>{t('时间')}</th>
                  <th>{t('回合')}</th>
                  <th>{t('输入')}</th>
                  <th>{t('输出')}</th>
                  <th>{t('缓存读')}</th>
                  <th>{t('缓存写')}</th>
                  <th>{t('费用')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleSessions.map((row) => (
                  <tr key={row.threadId}>
                    <td>
                      <div>{displayThreadTitle(row, t)}</div>
                      {row.project && <div className="muted small">{row.project}</div>}
                    </td>
                    <td className="usage-model">
                      {row.models.length === 0 ? (
                        '—'
                      ) : (
                        row.models.map((model) => <div key={model.id}>{modelName(model.id, model.label)}</div>)
                      )}
                    </td>
                    <td>{row.at ? relativeTime(row.at) : '—'}</td>
                    <td>{row.turns}</td>
                    <td>
                      <UsageToken n={row.inputTokens} />
                    </td>
                    <td>
                      <UsageToken n={row.outputTokens} />
                    </td>
                    <td>
                      <UsageToken n={row.cacheReadTokens} />
                    </td>
                    <td>
                      <UsageToken n={row.cacheWriteTokens} />
                    </td>
                    <td>{row.turns === 0 ? '—' : formatUsd(row.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="usage-pager">
            <span className="muted">{t('共 {count} 条', { count: sessions.length })}</span>
            {pageCount > 1 && (
              <>
                <button type="button" className="usage-period" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
                  {t('上一页')}
                </button>
                <span>
                  {currentPage} / {pageCount}
                </span>
                <button type="button" className="usage-period" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>
                  {t('下一页')}
                </button>
              </>
            )}
          </div>
        </>
      )}
      <p className="usage-note">
        {t('费用按公开标价估算，单位为美元 / 百万 token。')}{' '}
        {PRICE_SOURCES[provider].map(({ label, href }) => (
          <span key={href}><Hyperlink href={href} target="_blank" rel="noreferrer">{t(label)}</Hyperlink>{' '}</span>
        ))}
        {provider === 'cursor' && <>{t('Cursor 的费用估算不含 Teams Token Rate。')}{' '}</>}
        {t('未定价的模型只计 token。汇总中，同一回合的分叉副本只计一次。会话列表按当前 CLI 的全部历史回合累计。')}
      </p>
    </>
  )
}
