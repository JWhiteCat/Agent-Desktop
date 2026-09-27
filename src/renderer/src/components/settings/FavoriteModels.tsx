import { useEffect, useMemo, useState } from 'react'
import type { CliProvider } from '@shared/types'
import { groupModels } from '../../lib/models'
import { favoritesFor } from '../../lib/model-prefs'
import { loadModels, setFavoriteModels, useStore } from '../../store'
import { IconRefresh } from '../icons'

export function FavoriteModels({ provider }: { provider: CliProvider }) {
  const models = useStore((s) => s.modelsByCli[provider] ?? (provider === 'cursor' ? s.models : []))
  const modelError = useStore((s) => s.modelErrorByCli[provider])
  const favoriteModels = useStore((s) => favoritesFor(s.app.settings, provider))
  const groups = useMemo(() => groupModels(models), [models])
  const [q, setQ] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [loading, setLoading] = useState(false)
  const selected = useMemo(() => new Set(favoriteModels), [favoriteModels])

  useEffect(() => {
    const thin = provider === 'cursor' ? models.length <= 1 : models.length === 0
    if (!thin) return
    let cancel = false
    setLoading(true)
    void loadModels(false, provider).finally(() => {
      if (!cancel) setLoading(false)
    })
    return () => {
      cancel = true
    }
  }, [provider, models.length])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return groups
    return groups.filter((g) => g.name.toLowerCase().includes(s) || g.base.toLowerCase().includes(s))
  }, [groups, q])

  const selectedCount = groups.filter((g) => selected.has(g.base)).length
  const filteredBases = filtered.map((g) => g.base)
  const allFilteredOn = filteredBases.length > 0 && filteredBases.every((base) => selected.has(base))

  const toggle = (base: string) => {
    setFavoriteModels(selected.has(base) ? favoriteModels.filter((id) => id !== base) : [...favoriteModels, base], provider)
  }

  const toggleFiltered = () => {
    if (allFilteredOn) {
      const drop = new Set(filteredBases)
      setFavoriteModels(favoriteModels.filter((id) => !drop.has(id)), provider)
      return
    }
    const next = new Set(favoriteModels)
    for (const base of filteredBases) next.add(base)
    setFavoriteModels([...next], provider)
  }

  return (
    <div className="favorite-models">
      <div className="muted small">对话中只能选择这里勾选的模型。都不勾选时，对话中显示全部模型。</div>
      <div className="favorite-toolbar">
        <input className="input" placeholder="搜索模型" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" type="button" disabled={!filteredBases.length} onClick={toggleFiltered}>
          {allFilteredOn ? '取消全选' : q.trim() ? '全选筛选' : '全选'}
        </button>
        <button className="btn" type="button" disabled={!favoriteModels.length} onClick={() => setFavoriteModels([], provider)}>
          清空
        </button>
        <button
          className="icon-btn"
          type="button"
          title="刷新模型列表"
          onClick={async () => {
            setRefreshing(true)
            await loadModels(true, provider)
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
        {filtered.length === 0 && (
          <div className="empty-hint">{groups.length ? '无匹配模型' : loading || refreshing ? '正在加载模型…' : modelError || '尚未加载模型'}</div>
        )}
      </div>
    </div>
  )
}
