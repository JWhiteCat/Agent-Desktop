import { useEffect, useState } from 'react'
import { BUILTIN_SKINS, DEFAULT_SKIN, normalizeSkin, skinUrl, type SkinConfig, type SkinSource, type WallpaperEntry } from '@shared/skins'
import { useT } from '../../lib/i18n'
import { errorText, setState, toast, useStore } from '../../store'
import { Field } from './Field'

export function SkinSettings() {
  const t = useT()
  const settings = useStore(s => s.app.settings)
  const saved = JSON.stringify(settings.skin)
  const [draft, setDraft] = useState(() => normalizeSkin(settings.skin))
  const [source, setSource] = useState<SkinSource>()
  const [entries, setEntries] = useState<WallpaperEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const remote = window.api.isRemote
  useEffect(() => { setDraft(normalizeSkin(saved ? JSON.parse(saved) : undefined)); setState({ skinPreview: undefined }) }, [saved])
  useEffect(() => () => setState({ skinPreview: undefined }), [])
  useEffect(() => {
    let canceled = false
    setSource(undefined)
    if (draft.sourceId && !remote) void window.api.skinSource(draft.sourceId).then(s => { if (!canceled) setSource(s) }, () => {})
    return () => { canceled = true }
  }, [draft.sourceId, remote])
  const change = (patch: Partial<SkinConfig>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    setState({ skinPreview: next })
  }
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try { await action() } catch (e) { toast(errorText(e), 'error') } finally { setBusy(false) }
  }
  const selectSource = (s: SkinSource) => {
    setSource(s)
    change({ sourceId: s.id, background: s.kind, properties: {}, opacity: draft.opacity === 100 ? 82 : draft.opacity })
  }
  const scan = (manual = false) => run(async () => {
    const result = await window.api.skinScanWallpapers(manual)
    if (result) setEntries(result)
  })
  const cancel = () => { setDraft(normalizeSkin(settings.skin)); setState({ skinPreview: undefined }) }
  const selected = source?.id === draft.sourceId ? source : undefined
  const palette = [{ key: 'background', label: '背景色' }, { key: 'panel', label: '面板色' }, { key: 'text', label: '文字色' }, { key: 'accent', label: '强调色' }] as const
  const visibleEntries = entries?.filter(e => (filter === 'all' || e.type === filter) && e.title.toLowerCase().includes(query.toLowerCase()))
  return <section className="appearance-group skin-settings" aria-labelledby="skin-heading">
    <h3 id="skin-heading">{t('皮肤')}</h3>
    <p className="muted small">{t(remote ? '远程端仅同步配色、透明度和模糊效果。' : '修改即时预览，应用后保存；关闭设置或取消将还原未应用的修改。')}</p>
    {!remote && <Field label={t('选择皮肤')}><select className="input" aria-label={t('选择皮肤')} value={[...BUILTIN_SKINS, ...(settings.skins ?? [])].some(s => s.id === draft.id) ? draft.id : 'default'} onChange={e => {
      const skin = [...BUILTIN_SKINS, ...(settings.skins ?? [])].find(s => s.id === e.target.value)
      if (skin) change(skin)
    }}>{[...BUILTIN_SKINS, ...(settings.skins ?? [])].map(s => <option key={s.id} value={s.id}>{BUILTIN_SKINS.some(b => b.id === s.id) ? t(s.name) : s.name}</option>)}</select></Field>}
    {!remote && <Field label={t('皮肤名称')}><input className="input" aria-label={t('皮肤名称')} value={draft.name} maxLength={80} onChange={e => change({ name: e.target.value })} /></Field>}
    <div className="skin-palette">{palette.map(({ key, label }) => <label key={key}>
      <span>{t(label)}</span><input type="color" aria-label={t(label)} value={draft.colors[key] ?? '#808080'} onChange={e => change({ colors: { ...draft.colors, [key]: e.target.value } })} />
      <button type="button" className="link-btn" disabled={!draft.colors[key]} onClick={() => { const colors = { ...draft.colors }; delete colors[key]; change({ colors }) }}>{t('跟随主题')}</button>
    </label>)}</div>
    {([{ key: 'opacity', label: '面板不透明度', max: 100, unit: '%' }, { key: 'blur', label: '模糊半径', max: 40, unit: 'px' }, { key: 'overlay', label: '背景遮罩', max: 100, unit: '%' }] as const).filter(p => !remote || p.key !== 'overlay').map(p => <Field key={p.key} label={t(p.label)}><label className="skin-range"><input type="range" aria-label={t(p.label)} min={0} max={p.max} value={draft[p.key]} onChange={e => change({ [p.key]: Number(e.target.value) })} /><output>{draft[p.key]}{p.unit}</output></label></Field>)}
    {!remote && <>
      <Field label={t('背景类型')}><select className="input" aria-label={t('背景类型')} value={draft.background} onChange={e => change({ background: e.target.value as SkinConfig['background'] })}>
        <option value="none">{t('无背景')}</option><option value="gradient">{t('动态流光')}</option>
        {selected && <option value={selected.kind}>{t('本地素材')}</option>}
      </select></Field>
      <Field label={t('背景缩放')}><select className="input" aria-label={t('背景缩放')} value={draft.fit} onChange={e => change({ fit: e.target.value as SkinConfig['fit'] })}><option value="cover">{t('铺满裁切')}</option><option value="contain">{t('完整显示')}</option></select></Field>
      <div className="skin-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { const s = await window.api.skinPickSource(); if (s) selectSource(s) })}>{t('选择文件 / 重新定位')}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { const s = await window.api.skinPickSource(true); if (s) selectSource(s) })}>{t('选择 Web 项目')}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => change({ background: 'none', sourceId: '', properties: {} })}>{t('移除背景引用')}</button>
      </div>
      {draft.sourceId && <p className="muted small skin-source">{selected ? `${selected.title} · ${selected.root}` : t('素材不可用，请重新定位。')}</p>}
      {selected?.kind === 'web' && Object.entries(selected.properties).length > 0 && <details className="skin-properties"><summary>{t('Web 壁纸属性')}</summary>{Object.entries(selected.properties).map(([key, property]) => {
        const value = draft.properties[key] ?? property.value
        const update = (v: string | number | boolean) => change({ properties: { ...draft.properties, [key]: v } })
        return <Field key={key} label={property.text}>
          {property.type === 'bool' ? <input type="checkbox" aria-label={property.text} checked={Boolean(value)} onChange={e => update(e.target.checked)} />
            : property.type === 'slider' ? <input className="input" aria-label={property.text} type="number" min={property.min} max={property.max} step={property.step ?? 'any'} value={String(value)} onChange={e => update(Number(e.target.value))} />
              : property.type === 'combo' ? <select className="input" aria-label={property.text} value={JSON.stringify(value)} onChange={e => update(JSON.parse(e.target.value))}>{property.options?.map((o, i) => <option key={i} value={JSON.stringify(o.value)}>{o.label}</option>)}</select>
                : <input className="input" aria-label={property.text} maxLength={2000} value={String(value)} onChange={e => update(e.target.value)} />}
        </Field>
      })}</details>}
      <p className="muted small">{t('素材引用原文件；移动文件或取消订阅后需要重新选择。Web 仅支持本地资源和基础属性，不支持 Scene 或实时音频响应。')}</p>
      <div className="skin-actions"><button type="button" className="btn" disabled={busy} onClick={() => void scan()}>{t(busy ? '正在扫描…' : '刷新 Wallpaper 壁纸库')}</button><button type="button" className="btn" disabled={busy} onClick={() => void scan(true)}>{t('添加壁纸库目录')}</button></div>
      {entries !== null && <div className="skin-library">
        <div className="skin-actions"><input className="input" aria-label={t('搜索壁纸')} placeholder={t('搜索壁纸')} value={query} onChange={e => setQuery(e.target.value)} /><select className="input" aria-label={t('壁纸类型')} value={filter} onChange={e => setFilter(e.target.value)}>{['all', 'video', 'web', 'scene', 'application', 'unknown'].map(type => <option key={type} value={type}>{type === 'all' ? t('全部类型') : type}</option>)}</select></div>
        {visibleEntries?.length === 0 && <p className="muted small">{t('未找到壁纸，可添加目录后重试。')}</p>}
        <div className="skin-library-list">{visibleEntries?.map(entry => <button type="button" key={entry.id} className="skin-library-entry" disabled={!entry.available || busy} onClick={() => entry.source && selectSource(entry.source)}>
          {entry.source?.preview && <img loading="lazy" src={skinUrl(entry.source, true)} alt="" />}
          <span><strong>{entry.title}</strong><small>{entry.type} · {entry.available ? t('可用') : entry.reason}</small></span>
        </button>)}</div>
      </div>}
    </>}
    <div className="skin-actions">
      <button type="button" className="btn primary" disabled={busy} onClick={() => void run(async () => {
        if (!remote && settings.skins?.some(s => s.id === draft.id)) await window.api.skinSave(draft)
        else await window.api.updateSettings({ skin: draft })
        setState({ skinPreview: undefined })
      })}>{t('应用皮肤')}</button>
      <button type="button" className="btn" disabled={busy} onClick={cancel}>{t('取消预览')}</button>
      {!remote && <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { const skin = await window.api.skinSave({ ...draft, id: '' }); setDraft(skin); setState({ skinPreview: undefined }) })}>{t('另存为皮肤')}</button>}
      {!remote && <button type="button" className="btn" disabled={busy || !settings.skins?.some(s => s.id === draft.id)} onClick={() => void run(async () => { await window.api.skinDelete(draft.id); change(DEFAULT_SKIN) })}>{t('删除自定义皮肤')}</button>}
      <button type="button" className="btn" disabled={busy} onClick={() => change(DEFAULT_SKIN)}>{t('恢复默认皮肤')}</button>
    </div>
  </section>
}
