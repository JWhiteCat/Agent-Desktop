import { useEffect, useMemo, useState } from 'react'
import type { CliSession, Settings } from '@shared/types'
import { relativeTime, shortPath } from '../lib/format'
import { errorText, loadModels, rememberModel, preferredModel, toast, useStore } from '../store'
import { ModelPicker } from './ModelPicker'
import { MODES } from './Composer'
import { IconFolder, IconRefresh, IconX, Spinner } from './icons'

function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose}>
            <IconX size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
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

export function SettingsDialog({ onClose, onOpenImport }: { onClose: () => void; onOpenImport: () => void }) {
  const settings = useStore((s) => s.app.settings)
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.api.cliInfo>> | null>(null)
  const [checking, setChecking] = useState(false)
  const [agentPath, setAgentPath] = useState(settings.agentPath)
  const [loggingIn, setLoggingIn] = useState(false)

  const check = async () => {
    setChecking(true)
    try {
      setInfo(await window.api.cliInfo())
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    check()
  }, [])

  const update = (patch: Partial<Settings>) => window.api.updateSettings(patch)

  return (
    <Modal title="设置" onClose={onClose}>
      <section className="settings-section">
        <h4>Cursor CLI</h4>
        <div className="cli-card">
          {checking && !info ? (
            <div className="row-gap">
              <Spinner /> <span className="muted">正在检测…</span>
            </div>
          ) : info?.found ? (
            <>
              <div className="row-gap">
                <span className="ok-dot" /> <strong>已找到</strong> <span className="muted small">{info.version}</span>
              </div>
              <div className="muted small mono break">{info.path}</div>
              {info.status && <pre className="cli-status">{info.status}</pre>}
            </>
          ) : (
            <>
              <div className="row-gap">
                <span className="err-dot" /> <strong>未找到 Cursor CLI</strong>
              </div>
              <div className="muted small">
                安装方式：Windows 在 PowerShell 执行 <code className="inline-code">irm 'https://cursor.com/install?win32=true' | iex</code>
                ；macOS / Linux 执行 <code className="inline-code">curl https://cursor.com/install -fsS | bash</code>
              </div>
            </>
          )}
          <div className="row-gap wrap">
            <button className="btn" onClick={check} disabled={checking}>
              <IconRefresh size={13} className={checking ? 'spin' : ''} /> 重新检测
            </button>
            <button
              className="btn"
              disabled={!info?.found || loggingIn}
              onClick={async () => {
                setLoggingIn(true)
                try {
                  const out = await window.api.login()
                  toast(out.split('\n').pop() || '登录流程已结束')
                  check()
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
        <Field label="CLI 路径" desc="留空自动检测；可填 agent 可执行文件或安装目录">
          <input
            className="input"
            value={agentPath}
            placeholder="自动检测"
            onChange={(e) => setAgentPath(e.target.value)}
            onBlur={async () => {
              if (agentPath !== settings.agentPath) {
                await update({ agentPath })
                check()
                loadModels(true)
              }
            }}
          />
        </Field>
      </section>

      <section className="settings-section">
        <h4>默认值</h4>
        <Field label="默认模型" desc="新对话会沿用这里的选择">
          <ModelPicker value={preferredModel(settings.defaultModel)} onChange={rememberModel} />
        </Field>
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
        <Field label="CLI 历史会话" desc="从 ~/.cursor/chats 导入，按工作目录自动归入项目">
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
      title="导入 Cursor CLI 历史会话"
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
        {sessions && sessions.length === 0 && <div className="empty-hint">没有在 ~/.cursor/chats 中找到 CLI 会话</div>}
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
                  <span className="import-title">{s.title}</span>
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
