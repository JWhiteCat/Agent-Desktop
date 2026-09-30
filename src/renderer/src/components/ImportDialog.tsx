import { useT } from '../lib/i18n'
import { useEffect, useMemo, useState } from 'react'
import { cliTitle, type CliSession } from '@shared/types'
import { displayThreadTitle } from '@shared/thread-title'
import { relativeTime, shortPath } from '../lib/format'
import { errorText, toast } from '../store'
import { IconFolder, Spinner } from './icons'
import { Modal } from './Modal'

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
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
      if (q && !displayThreadTitle(s, t).toLowerCase().includes(q) && !s.cwd.toLowerCase().includes(q)) continue
      const arr = m.get(s.cwd) ?? []
      arr.push(s)
      m.set(s.cwd, arr)
    }
    return [...m.entries()]
  }, [sessions, filter, t])

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
      title={t('导入 CLI 历史会话')}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted small">{t('已选 {count} 个 · 同一目录的会话会归入同一项目', { count: pending.length })}</span>
          <div className="row-gap">
            <button className="btn" disabled={!visibleIds.length} onClick={() => toggle(visibleIds, !allVisibleOn)}>
              {allVisibleOn ? t('全不选') : filter.trim() ? t('全选筛选结果') : t('全选')}
            </button>
            <button className="btn" onClick={onClose}>
              {t('取消')}
            </button>
            <button
              className="btn primary"
              disabled={!pending.length || busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const n = await window.api.importCliSessions(pending)
                  toast(t('已导入 {count} 个会话', { count: n }))
                  onClose()
                } catch (err) {
                  toast(errorText(err), 'error')
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? <Spinner size={12} /> : null} {t('导入')}
            </button>
          </div>
        </>
      }
    >
      <input className="input" placeholder={t('按标题或目录筛选')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="import-list">
        {!sessions && (
          <div className="center-hint">
            <Spinner />
          </div>
        )}
        {sessions && sessions.length === 0 && <div className="empty-hint">{t('没有在 ~/.cursor/chats 或 ~/.codex/sessions 中找到 CLI 会话')}</div>}
        {groups.map(([cwd, list]) => {
          const ids = list.filter((s) => !s.imported).map((s) => s.chatId)
          const allOn = ids.length > 0 && ids.every((id) => selected.has(id))
          return (
            <div key={cwd} className="import-group">
              <label className="import-group-head" title={cwd}>
                <input type="checkbox" checked={allOn} disabled={!ids.length} onChange={(e) => toggle(ids, e.target.checked)} />
                <IconFolder size={14} />
                <span className="import-cwd">{shortPath(cwd)}</span>
                <span className="muted small">{t('{count} 个会话', { count: list.length })}</span>
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
                    {displayThreadTitle(s, t)} <span className="badge">{cliTitle(s.cli)}</span>
                  </span>
                  <span className="muted small">{s.imported ? t('已导入') : relativeTime(s.updatedAt)}</span>
                </label>
              ))}
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
