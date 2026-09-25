import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import type { CliInfo, CliProvider, CliSession, RemoteInfo, Settings } from '@shared/types'
import type { UsageSessionRow, UsageSummary, UsageWindow } from '@shared/usage'
import { compactNumber, formatUsd, relativeTime, shortPath } from '../lib/format'
import { groupModels, modelCaption } from '../lib/models'
import { errorText, loadModels, modelForChat, setDefaultModel, setFavoriteModels, toast, useStore } from '../store'
import { ModelPicker } from './ModelPicker'
import { MODES } from './Composer'
import { McpSettings, SkillSettings } from './AgentConfigSettings'
import { IconFolder, IconRefresh, IconX, Spinner } from './icons'

function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  nav
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
  nav?: React.ReactNode
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

const NO_FAVORITES: string[] = []

function FavoriteModels() {
  const cli = useStore((s) => (s.app.settings.cliProvider === 'codex' ? 'codex' : 'cursor'))
  const models = useStore((s) => s.modelsByCli[cli] ?? s.models)
  const favoriteModels = useStore((s) => s.app.settings.favoriteModels) ?? NO_FAVORITES
  const groups = useMemo(() => groupModels(models), [models])
  const [q, setQ] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const selected = useMemo(() => new Set(favoriteModels), [favoriteModels])

  useEffect(() => {
    if (models.length <= 1) void loadModels()
  }, [models.length])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return groups
    return groups.filter((g) => g.name.toLowerCase().includes(s) || g.base.toLowerCase().includes(s))
  }, [groups, q])

  const selectedCount = groups.filter((g) => selected.has(g.base)).length
  const filteredBases = filtered.map((g) => g.base)
  const allFilteredOn = filteredBases.length > 0 && filteredBases.every((base) => selected.has(base))

  const toggle = (base: string) => {
    setFavoriteModels(selected.has(base) ? favoriteModels.filter((id) => id !== base) : [...favoriteModels, base])
  }

  const toggleFiltered = () => {
    if (allFilteredOn) {
      const drop = new Set(filteredBases)
      setFavoriteModels(favoriteModels.filter((id) => !drop.has(id)))
      return
    }
    const next = new Set(favoriteModels)
    for (const base of filteredBases) next.add(base)
    setFavoriteModels([...next])
  }

  return (
    <div className="favorite-models">
      <div className="muted small">对话中只能选择这里勾选的模型。都不勾选时，对话中显示全部模型。</div>
      <div className="favorite-toolbar">
        <input className="input" placeholder="搜索模型" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" type="button" disabled={!filteredBases.length} onClick={toggleFiltered}>
          {allFilteredOn ? '取消全选' : q.trim() ? '全选筛选' : '全选'}
        </button>
        <button className="btn" type="button" disabled={!favoriteModels.length} onClick={() => setFavoriteModels([])}>
          清空
        </button>
        <button
          className="icon-btn"
          type="button"
          title="刷新模型列表"
          onClick={async () => {
            setRefreshing(true)
            await loadModels(true, cli)
            setRefreshing(false)
          }}
        >
          <IconRefresh size={13} className={refreshing ? 'spin' : ''} />
        </button>
      </div>
      <div className="muted small">
        已选 {selectedCount} / {groups.length}
      </div>
      <div className="favorite-list">
        {filtered.map((g) => (
          <label key={g.base} className="favorite-item">
            <input type="checkbox" checked={selected.has(g.base)} onChange={() => toggle(g.base)} />
            <span className="favorite-name">{g.name}</span>
            {g.base !== g.name && <span className="favorite-base">{g.base}</span>}
          </label>
        ))}
        {filtered.length === 0 && <div className="empty-hint">{groups.length ? '无匹配模型' : '尚未加载模型'}</div>}
      </div>
    </div>
  )
}

function Field({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
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

function RemoteSettings() {
  const settings = useStore((s) => s.app.settings)
  const view = useStore((s) => s.view)
  const [info, setInfo] = useState<RemoteInfo | null>(null)
  const [port, setPort] = useState(String(settings.remotePort))
  const [pubUser, setPubUser] = useState(settings.remotePublicUser)
  const [pubHost, setPubHost] = useState(settings.remotePublicHost)
  const [pubPort, setPubPort] = useState(String(settings.remotePublicPort))
  const [urlIndex, setUrlIndex] = useState(0)
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => {
      window.api.remoteInfo().then((i) => alive && setInfo(i), () => {})
    }
    load()
    const timer = settings.remotePublicEnabled ? setInterval(load, 1500) : undefined
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [
    settings.remoteEnabled,
    settings.remotePort,
    settings.remoteToken,
    settings.remotePublicEnabled,
    settings.remotePublicUser,
    settings.remotePublicHost,
    settings.remotePublicPort
  ])

  useEffect(() => {
    if (!info?.publicUrl) return
    const index = info.urls.indexOf(info.publicUrl)
    if (index >= 0) setUrlIndex(index)
  }, [info?.publicUrl])

  const hash = view.kind === 'thread' ? `#thread=${view.id}` : view.projectId ? `#project=${view.projectId}` : ''
  const base = info?.urls[urlIndex] ?? info?.urls[0]
  const link = base ? base + hash : ''

  useEffect(() => {
    if (!link) {
      setQr('')
      return
    }
    let alive = true
    QRCode.toDataURL(link, { margin: 1, width: 220 }).then((d) => alive && setQr(d), () => {})
    return () => {
      alive = false
    }
  }, [link])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Field label="启用远程控制" desc="在局域网内提供网页，手机与电脑连同一 Wi-Fi 后扫码即可操作。持有链接即可完全控制本应用，请勿外传">
        <input
          type="checkbox"
          className="toggle"
          checked={settings.remoteEnabled}
          disabled={busy}
          onChange={(e) => run(() => window.api.updateSettings({ remoteEnabled: e.target.checked }))}
        />
      </Field>
      <Field label="端口">
        <input
          className="input"
          inputMode="numeric"
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
          onBlur={() => {
            if (port === String(settings.remotePort)) return
            run(() =>
              window.api.updateSettings({ remotePort: Number(port) }).catch((err) => {
                setPort(String(settings.remotePort))
                throw err
              })
            )
          }}
        />
      </Field>
      <Field label="公网访问" desc="用 SSH 反向隧道把上面的网页暴露到公网。链接是明文 HTTP，持有者可完全控制本应用。需本机默认密钥能登录所填用户">
        <input
          type="checkbox"
          className="toggle"
          checked={settings.remotePublicEnabled}
          disabled={busy || (!settings.remoteEnabled && !settings.remotePublicEnabled)}
          onChange={(e) => run(() => window.api.updateSettings({ remotePublicEnabled: e.target.checked }))}
        />
      </Field>
      <Field label="SSH 用户">
        <input
          className="input"
          value={pubUser}
          disabled={busy}
          onChange={(e) => setPubUser(e.target.value)}
          onBlur={() => {
            if (pubUser === settings.remotePublicUser) return
            run(() =>
              window.api.updateSettings({ remotePublicUser: pubUser }).catch((err) => {
                setPubUser(settings.remotePublicUser)
                throw err
              })
            )
          }}
        />
      </Field>
      <Field label="服务器地址">
        <input
          className="input"
          value={pubHost}
          disabled={busy}
          spellCheck={false}
          onChange={(e) => setPubHost(e.target.value.trim())}
          onBlur={() => {
            if (pubHost === settings.remotePublicHost) return
            run(() =>
              window.api.updateSettings({ remotePublicHost: pubHost }).catch((err) => {
                setPubHost(settings.remotePublicHost)
                throw err
              })
            )
          }}
        />
      </Field>
      <Field label="公网端口">
        <input
          className="input"
          inputMode="numeric"
          value={pubPort}
          disabled={busy}
          onChange={(e) => setPubPort(e.target.value.replace(/\D/g, ''))}
          onBlur={() => {
            if (pubPort === String(settings.remotePublicPort)) return
            run(() =>
              window.api.updateSettings({ remotePublicPort: Number(pubPort) }).catch((err) => {
                setPubPort(String(settings.remotePublicPort))
                throw err
              })
            )
          }}
        />
      </Field>
      {info?.error && <div className="remote-error small">{info.error}</div>}
      {settings.remotePublicEnabled && info?.publicStatus === 'connecting' && <div className="muted small">正在连接公网…</div>}
      {settings.remotePublicEnabled && info?.publicStatus === 'up' && <div className="muted small">公网已连接</div>}
      {info?.publicError && <div className="remote-error small">{info.publicError}</div>}
      {settings.remoteEnabled && info?.running && (
        <div className="remote-card">
          {qr ? <img className="remote-qr" src={qr} alt="远程控制二维码" /> : <div className="remote-qr" />}
          <div className="remote-detail">
            {info.urls.length === 0 ? (
              <div className="muted small">未检测到局域网地址，请确认电脑已连接 Wi-Fi 或有线网络</div>
            ) : (
              <>
                {info.urls.length > 1 && (
                  <select className="input" value={urlIndex} onChange={(e) => setUrlIndex(Number(e.target.value))}>
                    {info.urls.map((u, i) => (
                      <option key={u} value={i}>
                        {new URL(u).host}
                      </option>
                    ))}
                  </select>
                )}
                <div className="mono small break remote-link">{link}</div>
                <div className="muted small">扫码后打开的是当前正在查看的{view.kind === 'thread' ? '对话' : '项目'}</div>
              </>
            )}
            <div className="row-gap wrap">
              <button
                className="btn"
                disabled={!link}
                onClick={() => navigator.clipboard.writeText(link).then(() => toast('已复制链接'))}
              >
                复制链接
              </button>
              <button className="btn" disabled={busy} onClick={() => run(async () => setInfo(await window.api.resetRemoteToken()))}>
                重置链接
              </button>
            </div>
            <div className="muted small">重置后旧链接和已连接的手机会立即失效</div>
          </div>
        </div>
      )}
    </>
  )
}

const USAGE_PERIODS: { id: UsageWindow; label: string }[] = [
  { id: '1d', label: '1天' },
  { id: '7d', label: '7天' },
  { id: '30d', label: '30天' }
]

const USAGE_PAGE_SIZE = 20

function UsageToken({ n }: { n: number }) {
  return <span title={n.toLocaleString('zh-CN')}>{compactNumber(n)}</span>
}

function UsageSettings() {
  const models = useStore((s) => s.models)
  const groups = useMemo(() => groupModels(models), [models])
  const [period, setPeriod] = useState<UsageWindow>('7d')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [sessions, setSessions] = useState<UsageSessionRow[] | null>(null)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const modelName = (id: string, fallback = '') => (id ? modelCaption(groups, id) : fallback)

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
  }, [period])

  const pageCount = Math.max(1, Math.ceil((sessions?.length ?? 0) / USAGE_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const visibleSessions = sessions?.slice((currentPage - 1) * USAGE_PAGE_SIZE, currentPage * USAGE_PAGE_SIZE) ?? []

  return (
    <section className="settings-section">
      <h4>用量</h4>
      <div className="usage-periods" role="group" aria-label="统计范围">
        {USAGE_PERIODS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`usage-period ${period === item.id ? 'active' : ''}`}
            aria-pressed={period === item.id}
            onClick={() => setPeriod(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {error ? (
        <div className="notice error">{error}</div>
      ) : !summary ? (
        <div className="muted small">正在统计…</div>
      ) : summary.turns === 0 ? (
        <div className="muted small">这段时间没有用量</div>
      ) : (
        <>
          <div className="usage-stats">
            <div className="usage-stat">
              <div className="label">费用</div>
              <div className="value">{formatUsd(summary.costUsd)}</div>
            </div>
            <div className="usage-stat">
              <div className="label">回合</div>
              <div className="value">{summary.turns}</div>
            </div>
            <div className="usage-stat">
              <div className="label">输入</div>
              <div className="value"><UsageToken n={summary.inputTokens} /></div>
            </div>
            <div className="usage-stat">
              <div className="label">输出</div>
              <div className="value"><UsageToken n={summary.outputTokens} /></div>
            </div>
            <div className="usage-stat">
              <div className="label">缓存读</div>
              <div className="value"><UsageToken n={summary.cacheReadTokens} /></div>
            </div>
            <div className="usage-stat">
              <div className="label">缓存写</div>
              <div className="value"><UsageToken n={summary.cacheWriteTokens} /></div>
            </div>
          </div>
          {summary.unpricedTurns > 0 && summary.costUsd != null && (
            <div className="muted small">另有 {summary.unpricedTurns} 轮未定价，未计入费用。</div>
          )}
          <div className="usage-table-wrap">
            <table className="usage-table">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>回合</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>缓存读</th>
                  <th>缓存写</th>
                  <th>费用</th>
                </tr>
              </thead>
              <tbody>
                {summary.models.map((row) => (
                  <tr key={`${row.model}\n${row.label}`}>
                    <td>{modelName(row.model, row.label)}</td>
                    <td>{row.turns}</td>
                    <td><UsageToken n={row.inputTokens} /></td>
                    <td><UsageToken n={row.outputTokens} /></td>
                    <td><UsageToken n={row.cacheReadTokens} /></td>
                    <td><UsageToken n={row.cacheWriteTokens} /></td>
                    <td>{formatUsd(row.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h4>会话</h4>
      {sessions == null ? (
        error ? null : <div className="muted small">正在统计…</div>
      ) : sessions.length === 0 ? (
        <div className="muted small">还没有历史会话</div>
      ) : (
        <>
          <div className="usage-table-wrap">
            <table className="usage-table">
              <thead>
                <tr>
                  <th>会话</th>
                  <th className="usage-model">模型</th>
                  <th>时间</th>
                  <th>回合</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>缓存读</th>
                  <th>缓存写</th>
                  <th>费用</th>
                </tr>
              </thead>
              <tbody>
                {visibleSessions.map((row) => (
                  <tr key={row.threadId}>
                    <td>
                      <div>{row.title}</div>
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
                    <td><UsageToken n={row.inputTokens} /></td>
                    <td><UsageToken n={row.outputTokens} /></td>
                    <td><UsageToken n={row.cacheReadTokens} /></td>
                    <td><UsageToken n={row.cacheWriteTokens} /></td>
                    <td>{row.turns === 0 ? '—' : formatUsd(row.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="usage-pager">
            <span className="muted">共 {sessions.length} 条</span>
            {pageCount > 1 && (
              <>
                <button type="button" className="usage-period" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
                  上一页
                </button>
                <span>
                  {currentPage} / {pageCount}
                </span>
                <button
                  type="button"
                  className="usage-period"
                  disabled={currentPage >= pageCount}
                  onClick={() => setPage(currentPage + 1)}
                >
                  下一页
                </button>
              </>
            )}
          </div>
        </>
      )}
      <p className="usage-note">
        Cursor 模型按 Cursor 公开标价估算，Codex 的 GPT 模型用同一份已收录的公开 token 标价（美元 / 百万 token）。这不是套餐剩余额度，也不含 Teams 的 Token Rate。Auto 和价目表没有的模型只计 token。上方合计里，分叉复制的同一轮只计一次。会话列表包含全部历史对话，按各对话自己的记录累计，不受上面的天数限制；没有 token 记录的对话费用留空。
      </p>
    </section>
  )
}

const SETTINGS_TABS = [
  { id: 'cli', label: 'CLI' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skill', label: 'Skill' },
  { id: 'models', label: '模型' },
  { id: 'usage', label: '用量' },
  { id: 'defaults', label: '默认值' },
  { id: 'notify', label: '通知' },
  { id: 'remote', label: '远程控制' },
  { id: 'appearance', label: '外观与历史' }
] as const

type SettingsTab = (typeof SETTINGS_TABS)[number]['id']

function CliCard({
  provider,
  pathValue,
  pathPlaceholder,
  pathDesc,
  keyValue,
  keyPlaceholder,
  keyDesc,
  missing,
  install,
  onPath,
  onKey
}: {
  provider: CliProvider
  pathValue: string
  pathPlaceholder: string
  pathDesc: string
  keyValue: string
  keyPlaceholder: string
  keyDesc: string
  missing: string
  install: string
  onPath: (value: string) => void | Promise<void>
  onKey: (value: string) => void | Promise<void>
}) {
  const [info, setInfo] = useState<CliInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [pathDraft, setPathDraft] = useState(pathValue)
  const [keyDraft, setKeyDraft] = useState(keyValue)

  const check = async () => {
    setChecking(true)
    try {
      setInfo(await window.api.cliInfo(provider))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void check()
  }, [provider])

  return (
    <>
      <div className="cli-card">
        {checking && !info ? (
          <div className="row-gap">
            <Spinner /> <span className="muted">正在检测…</span>
          </div>
        ) : info?.found ? (
          <>
            <div className="row-gap">
              <span className="ok-dot" /> <strong>{info.bundled ? '使用内置 Codex' : '已找到'}</strong>{' '}
              <span className="muted small">{info.version}</span>
            </div>
            <div className="muted small mono break">{info.path}</div>
            {info.status && <pre className="cli-status">{info.status}</pre>}
          </>
        ) : (
          <>
            <div className="row-gap">
              <span className="err-dot" /> <strong>{missing}</strong>
            </div>
            <div className="muted small">{install}</div>
          </>
        )}
        <div className="row-gap wrap">
          <button className="btn" onClick={() => void check()} disabled={checking}>
            <IconRefresh size={13} className={checking ? 'spin' : ''} /> 重新检测
          </button>
          <button
            className="btn"
            disabled={!info?.found || loggingIn}
            onClick={async () => {
              setLoggingIn(true)
              try {
                const out = await window.api.login(provider)
                toast(out.split('\n').pop() || '登录流程已结束')
                void check()
              } catch (err) {
                toast(errorText(err), 'error')
              } finally {
                setLoggingIn(false)
              }
            }}
          >
            {loggingIn ? <Spinner size={12} /> : null} 登录 / 重新登录
          </button>
        </div>
      </div>
      <Field label="API Key" desc={keyDesc}>
        <input
          className="input"
          type="password"
          value={keyDraft}
          placeholder={keyPlaceholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKeyDraft(e.target.value)}
          onBlur={() => {
            if (keyDraft !== keyValue) {
              void Promise.resolve(onKey(keyDraft)).then(() => check())
            }
          }}
        />
      </Field>
      <Field label="CLI 路径" desc={pathDesc}>
        <input
          className="input"
          value={pathDraft}
          placeholder={pathPlaceholder}
          onChange={(e) => setPathDraft(e.target.value)}
          onBlur={() => {
            if (pathDraft !== pathValue) {
              void Promise.resolve(onPath(pathDraft)).then(() => check())
            }
          }}
        />
      </Field>
    </>
  )
}

export function SettingsDialog({ onClose, onOpenImport }: { onClose: () => void; onOpenImport: () => void }) {
  const settings = useStore((s) => s.app.settings)
  const cli = settings.cliProvider === 'codex' ? 'codex' : 'cursor'
  const models = useStore((s) => s.modelsByCli[cli] ?? s.models)
  const [tab, setTab] = useState<SettingsTab>('cli')
  const tabs = SETTINGS_TABS.filter((item) => item.id !== 'remote' || !window.api.isRemote)

  const update = (patch: Partial<Settings>) => window.api.updateSettings(patch)
  const saveCli = async (patch: Partial<Settings>, provider: CliProvider) => {
    await update(patch)
    void loadModels(true, provider)
  }

  return (
    <Modal
      title="设置"
      onClose={onClose}
      nav={
        <nav className="settings-nav" aria-label="设置分类">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-nav-btn ${tab === item.id ? 'active' : ''}`}
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      }
    >
      {tab === 'cli' && (
      <section className="settings-section">
        <h4>CLI</h4>
        <Field label="新建对话使用" desc="已有对话继续使用创建时的 CLI。">
          <select
            className="input"
            value={cli}
            onChange={(e) => {
              const next = e.target.value === 'codex' ? 'codex' : 'cursor'
              void update({ cliProvider: next })
              void loadModels(false, next)
            }}
          >
            <option value="cursor">Cursor CLI</option>
            <option value="codex">Codex CLI</option>
          </select>
        </Field>
        <h4>Cursor CLI</h4>
        <CliCard
          provider="cursor"
          pathValue={settings.agentPath}
          pathPlaceholder="自动检测"
          pathDesc="留空自动检测；可填 agent 可执行文件或安装目录"
          keyValue={settings.apiKey ?? ''}
          keyPlaceholder="留空使用 CURSOR_API_KEY"
          keyDesc="有 Key 时优先使用（设置优先于环境变量 CURSOR_API_KEY）。都没有时使用浏览器登录。可在 cursor.com/dashboard/api 创建。"
          missing="未找到 Cursor CLI"
          install="安装方式：Windows 在 PowerShell 执行 irm 'https://cursor.com/install?win32=true' | iex ；macOS / Linux 执行 curl https://cursor.com/install -fsS | bash"
          onPath={(agentPath) => void saveCli({ agentPath }, 'cursor')}
          onKey={(apiKey) => void saveCli({ apiKey }, 'cursor')}
        />
        <h4>Codex CLI</h4>
        <CliCard
          provider="codex"
          pathValue={settings.codexPath ?? ''}
          pathPlaceholder="自动检测，否则使用内置 Codex"
          pathDesc="留空时先找本机 codex。找不到则使用应用内置的 Codex。"
          keyValue={settings.codexApiKey ?? ''}
          keyPlaceholder="留空使用 CODEX_API_KEY 或 OPENAI_API_KEY"
          keyDesc="有 Key 时优先使用。都没有时使用 ChatGPT 登录。"
          missing="未找到 Codex 适配器"
          install="需要安装本应用依赖里的 Codex 适配器。本机另有 codex 时会优先使用它。"
          onPath={(codexPath) => void saveCli({ codexPath }, 'codex')}
          onKey={(codexApiKey) => void saveCli({ codexApiKey }, 'codex')}
        />
      </section>
      )}

      {tab === 'mcp' && (
      <section className="settings-section">
        <h4>MCP</h4>
        <McpSettings />
      </section>
      )}

      {tab === 'skill' && (
      <section className="settings-section">
        <h4>Skill</h4>
        <SkillSettings />
      </section>
      )}

      {tab === 'models' && (
      <section className="settings-section">
        <h4>常用模型</h4>
        <FavoriteModels />
        <Field label="默认模型" desc="每个项目会记住自己上次选的模型。这里只给还没单独选过的项目用。勾选常用模型后，这里也只列出常用模型">
          <ModelPicker
            cli={cli}
            value={modelForChat(models, settings.favoriteModels, cli === 'codex' ? settings.codexDefaultModel : settings.defaultModel)}
            onChange={setDefaultModel}
          />
        </Field>
      </section>
      )}

      {tab === 'usage' && <UsageSettings />}

      {tab === 'defaults' && (
      <section className="settings-section">
        <h4>默认值</h4>
        <Field label="默认模式">
          <select className="input" value={settings.defaultMode} onChange={(e) => update({ defaultMode: e.target.value as Settings['defaultMode'] })}>
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.desc}
              </option>
            ))}
          </select>
        </Field>
        <Field label="默认完全访问" desc="开启后命令无需确认直接执行（--force）">
          <input type="checkbox" className="toggle" checked={settings.force} onChange={(e) => update({ force: e.target.checked })} />
        </Field>
        <Field label="沙箱" desc="对应 --sandbox 参数">
          <select className="input" value={settings.sandbox} onChange={(e) => update({ sandbox: e.target.value as Settings['sandbox'] })}>
            <option value="default">遵循 CLI 配置</option>
            <option value="enabled">启用</option>
            <option value="disabled">禁用</option>
          </select>
        </Field>
      </section>
      )}

      {tab === 'notify' && (
      <section className="settings-section">
        <h4>通知</h4>
        <Field label="任务完成时通知" desc="对话结束后发送系统通知，点击通知可回到该对话">
          <input
            type="checkbox"
            className="toggle"
            checked={settings.notifyOnComplete}
            onChange={(e) => update({ notifyOnComplete: e.target.checked })}
          />
        </Field>
      </section>
      )}

      {tab === 'remote' && !window.api.isRemote && (
        <section className="settings-section">
          <h4>远程控制</h4>
          <RemoteSettings />
        </section>
      )}

      {tab === 'appearance' && (
      <section className="settings-section">
        <h4>外观与历史</h4>
        <Field label="主题">
          <select className="input" value={settings.theme} onChange={(e) => update({ theme: e.target.value as Settings['theme'] })}>
            <option value="system">跟随系统</option>
            <option value="dark">深色</option>
            <option value="light">浅色</option>
          </select>
        </Field>
        <Field label="显示已归档对话">
          <input type="checkbox" className="toggle" checked={settings.showArchived} onChange={(e) => update({ showArchived: e.target.checked })} />
        </Field>
        <Field label="CLI 历史会话" desc="从 ~/.cursor/chats 和 ~/.codex/sessions 导入，按工作目录自动归入项目">
          <button
            className="btn"
            onClick={() => {
              onClose()
              onOpenImport()
            }}
          >
            导入…
          </button>
        </Field>
      </section>
      )}
    </Modal>
  )
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<CliSession[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.api.scanCliSessions().then(setSessions)
  }, [])

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const m = new Map<string, CliSession[]>()
    for (const s of sessions ?? []) {
      if (q && !s.title.toLowerCase().includes(q) && !s.cwd.toLowerCase().includes(q)) continue
      const arr = m.get(s.cwd) ?? []
      arr.push(s)
      m.set(s.cwd, arr)
    }
    return [...m.entries()]
  }, [sessions, filter])

  const toggle = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) on ? next.add(id) : next.delete(id)
      return next
    })

  const pending = [...selected].filter((id) => sessions?.find((s) => s.chatId === id && !s.imported))
  const visibleIds = groups.flatMap(([, list]) => list.filter((s) => !s.imported).map((s) => s.chatId))
  const allVisibleOn = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))

  return (
    <Modal
      title="导入 CLI 历史会话"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted small">已选 {pending.length} 个 · 同一目录的会话会归入同一项目</span>
          <div className="row-gap">
            <button className="btn" disabled={!visibleIds.length} onClick={() => toggle(visibleIds, !allVisibleOn)}>
              {allVisibleOn ? '全不选' : filter.trim() ? '全选筛选结果' : '全选'}
            </button>
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button
              className="btn primary"
              disabled={!pending.length || busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const n = await window.api.importCliSessions(pending)
                  toast(`已导入 ${n} 个会话`)
                  onClose()
                } catch (err) {
                  toast(errorText(err), 'error')
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? <Spinner size={12} /> : null} 导入
            </button>
          </div>
        </>
      }
    >
      <input className="input" placeholder="按标题或目录筛选" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="import-list">
        {!sessions && (
          <div className="center-hint">
            <Spinner />
          </div>
        )}
        {sessions && sessions.length === 0 && <div className="empty-hint">没有在 ~/.cursor/chats 或 ~/.codex/sessions 中找到 CLI 会话</div>}
        {groups.map(([cwd, list]) => {
          const ids = list.filter((s) => !s.imported).map((s) => s.chatId)
          const allOn = ids.length > 0 && ids.every((id) => selected.has(id))
          return (
            <div key={cwd} className="import-group">
              <label className="import-group-head" title={cwd}>
                <input type="checkbox" checked={allOn} disabled={!ids.length} onChange={(e) => toggle(ids, e.target.checked)} />
                <IconFolder size={14} />
                <span className="import-cwd">{shortPath(cwd)}</span>
                <span className="muted small">{list.length} 个会话</span>
              </label>
              {list.map((s) => (
                <label key={s.chatId} className={`import-item ${s.imported ? 'imported' : ''}`}>
                  <input
                    type="checkbox"
                    disabled={s.imported}
                    checked={s.imported || selected.has(s.chatId)}
                    onChange={(e) => toggle([s.chatId], e.target.checked)}
                  />
                  <span className="import-title">
                    {s.title} <span className="badge">{s.cli === 'codex' ? 'Codex' : 'Cursor'}</span>
                  </span>
                  <span className="muted small">{s.imported ? '已导入' : relativeTime(s.updatedAt)}</span>
                </label>
              ))}
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
