import { useEffect, useMemo, useRef, useState } from 'react'
import type { CliProvider } from '@shared/types'
import { favoritesFor } from '../lib/model-prefs'
import { loadModels, useStore } from '../store'
import {
  contextChoices,
  describeModel,
  effortChoices,
  findVariant,
  groupModels,
  hasFastVariant,
  listedModelGroups,
  pickVariant,
  speedAvailable,
  wantFrom,
  type ModelGroup
} from '../lib/models'
import { IconChevronDown, IconRefresh } from './icons'
import { Popover } from './Menu'

export function ModelPicker({ value, onChange, cli }: { value: string; onChange: (id: string) => void; cli?: CliProvider }) {
  const settingsCli = useStore((s) => (s.app.settings.cliProvider === 'codex' ? 'codex' : 'cursor'))
  const provider = cli ?? settingsCli
  const models = useStore((s) => s.modelsByCli[provider] ?? s.models)
  const favorites = useStore((s) => favoritesFor(s.app.settings, provider))
  const groups = useMemo(() => groupModels(models), [models])
  const favoritesApply = favorites.some((base) => groups.some((group) => group.base === base))
  const summary = useMemo(() => describeModel(groups, value), [groups, value])
  const selected = useMemo(() => findVariant(groups, value), [groups, value])
  const listed = useMemo(() => listedModelGroups(groups, favorites, selected?.base), [groups, favorites, selected?.base])
  const selectedGroup = groups.find((g) => g.base === selected?.base)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (selected?.legacySlug === value && selected.id !== value) onChange(selected.id)
  }, [selected, value, onChange])

  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => {
      search.current?.focus()
      list.current?.querySelector('.menu-item.selected')?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(id)
  }, [open])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return listed
    return listed.filter(
      (g) =>
        g.name.toLowerCase().includes(s) ||
        g.base.toLowerCase().includes(s) ||
        g.variants.some((v) => v.id.toLowerCase().includes(s) || v.label.toLowerCase().includes(s))
    )
  }, [listed, q])

  const select = (id: string) => {
    if (id !== value) onChange(id)
  }

  const chooseGroup = (group: ModelGroup) => {
    if (group.base !== selected?.base) select(pickVariant(group, wantFrom(selected)).id)
    setQ('')
  }

  const contexts = selectedGroup ? contextChoices(selectedGroup) : []
  const efforts = selectedGroup ? effortChoices(selectedGroup) : []
  const showSpeed = selectedGroup ? hasFastVariant(selectedGroup) : false

  return (
    <>
      <button
        ref={btn}
        className={`pill model-pill ${open ? 'active' : ''}`}
        title={[summary.name, summary.context, summary.effortLabel, summary.fast ? 'Fast' : undefined].filter(Boolean).join(' · ')}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="model-name">{summary.name}</span>
        {summary.context && <span className="model-meta">{summary.context}</span>}
        {summary.effortLabel && <span className="model-meta">{summary.effortLabel}</span>}
        {summary.fast && <span className="model-meta">Fast</span>}
        <IconChevronDown size={12} />
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} placement="top-start" className="model-popover">
        <div className="model-search">
          <input
            ref={search}
            placeholder={favoritesApply ? '搜索常用模型' : '搜索模型'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered[0]) chooseGroup(filtered[0])
            }}
          />
          <button
            className="icon-btn tiny"
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
        {favoritesApply && <div className="model-scope">仅常用模型</div>}
        <div className="model-list" ref={list}>
          {filtered.map((g) => (
            <button key={g.base} className={`menu-item ${g.base === selectedGroup?.base ? 'selected' : ''}`} onClick={() => chooseGroup(g)}>
              <span className="menu-label">{g.name}</span>
              {favoritesApply && g.base === selected?.base && !favorites.includes(g.base) && <span className="menu-hint">当前</span>}
              {g.base === selectedGroup?.base && <span className="menu-check">✓</span>}
            </button>
          ))}
          {filtered.length === 0 && <div className="empty-hint">{q.trim() ? '无匹配模型' : favoritesApply ? '没有可用的常用模型' : '无匹配模型'}</div>}
        </div>
        {selected && selectedGroup && (contexts.length > 0 || efforts.length > 0 || showSpeed) && (
          <div className="model-params">
            {contexts.length > 0 && (
              <ParamRow label="上下文">
                {contexts.map((context) => (
                  <button
                    key={context}
                    className={`model-opt ${selected.context === context ? 'selected' : ''}`}
                    onClick={() => select(pickVariant(selectedGroup, { ...wantFrom(selected), context }).id)}
                  >
                    {context}
                  </button>
                ))}
              </ParamRow>
            )}
            {efforts.length > 0 && (
              <ParamRow label="思考强度">
                {efforts.map((choice) => {
                  const on = selected.effort === choice.effort && selected.thinking === choice.thinking
                  return (
                    <button
                      key={`${choice.effort ?? ''}:${choice.thinking ? 1 : 0}`}
                      className={`model-opt ${on ? 'selected' : ''}`}
                      onClick={() => select(pickVariant(selectedGroup, { ...wantFrom(selected), effort: choice.effort, thinking: choice.thinking }).id)}
                    >
                      {choice.label}
                    </button>
                  )
                })}
              </ParamRow>
            )}
            {showSpeed && (
              <ParamRow label="速度">
                <button
                  className={`model-opt ${!selected.fast ? 'selected' : ''}`}
                  disabled={!speedAvailable(selectedGroup, selected, false)}
                  onClick={() => select(pickVariant(selectedGroup, { ...wantFrom(selected), fast: false }).id)}
                >
                  标准
                </button>
                <button
                  className={`model-opt ${selected.fast ? 'selected' : ''}`}
                  disabled={!speedAvailable(selectedGroup, selected, true)}
                  onClick={() => select(pickVariant(selectedGroup, { ...wantFrom(selected), fast: true }).id)}
                >
                  Fast
                </button>
              </ParamRow>
            )}
          </div>
        )}
      </Popover>
    </>
  )
}

function ParamRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="model-param">
      <div className="model-param-label">{label}</div>
      <div className="model-param-options">{children}</div>
    </div>
  )
}
