import { useEffect, useMemo, useState } from 'react'
import { getLocale } from '@shared/i18n'
import type { UsageSessionRow, UsageSummary, UsageWindow } from '@shared/usage'
import { cliTitle, type CliProvider } from '@shared/types'
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

function UsageToken({ n }: { n: number }) {
  useT()
  return <HoverTip text={n.toLocaleString(getLocale())}>{compactNumber(n)}</HoverTip>
}

export function UsageSettings() {
  const t = useT()
  const modelsByCli = useStore((s) => s.modelsByCli)
  const groups = useMemo(() => ({
    cursor: groupModels(modelsByCli.cursor),
    codex: groupModels(modelsByCli.codex),
    claude: groupModels(modelsByCli.claude)
  }), [modelsByCli])
  const [period, setPeriod] = useState<UsageWindow>('7d')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [sessions, setSessions] = useState<UsageSessionRow[] | null>(null)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const modelName = (cli: CliProvider, id: string, fallback = '') => (id ? modelCaption(groups[cli], id) : t(fallback))

  useEffect(() => {
    let cancel = false
    setSummary(null)
    setError('')
    window.api.usageSummary(period).then(
      (next) => {
        if (cancel) return
        setSummary(next.summary)
        setSessions(next.sessions)
      },
      (err) => {
        if (cancel) return
        setSummary(null)
        setError(errorText(err))
      }
    )
    return () => {
      cancel = true
    }
  }, [period, t])

  const pageCount = Math.max(1, Math.ceil((sessions?.length ?? 0) / USAGE_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const visibleSessions = sessions?.slice((currentPage - 1) * USAGE_PAGE_SIZE, currentPage * USAGE_PAGE_SIZE) ?? []

  return (
    <section className="settings-section">
      <QuotaPanel />
      <h4>{t('本机用量')}</h4>
      <div className="usage-periods" role="group" aria-label={t('统计范围')}>
        {USAGE_PERIODS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`usage-period ${period === item.id ? 'active' : ''}`}
            aria-pressed={period === item.id}
            onClick={() => setPeriod(item.id)}
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
                    <td>
                      <div>{modelName(row.cli, row.model, row.label)}</div>
                      <div className="muted small">{cliTitle(row.cli)}</div>
                    </td>
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
                      <div className="muted small">{cliTitle(row.cli)}</div>
                      {row.project && <div className="muted small">{row.project}</div>}
                    </td>
                    <td className="usage-model">
                      {row.models.length === 0 ? (
                        '—'
                      ) : (
                        row.models.map((model) => <div key={model.id}>{modelName(row.cli, model.id, model.label)}</div>)
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
        {t('Cursor 按 Cursor 公开标价估算，Codex 按 OpenAI API 公开标价估算，Claude Code 按 Anthropic API 公开标价估算（美元 / 百万 token）。')}{' '}
        <Hyperlink href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noreferrer">{t('OpenAI API 价格')}</Hyperlink>{' '}
        <Hyperlink href="https://claude.com/pricing#api" target="_blank" rel="noreferrer">{t('Anthropic API 价格')}</Hyperlink>{' '}
        {t('这些金额是用量估算，不代表订阅账单或套餐剩余额度；Cursor 估算不含 Teams 的 Token Rate。Auto 和价目表没有的模型只计 token。上方合计里，分叉复制的同一轮只计一次。会话列表包含全部历史对话，按各对话自己的记录累计，不受上面的天数限制；没有 token 记录的对话费用留空。')}
      </p>
    </section>
  )
}
