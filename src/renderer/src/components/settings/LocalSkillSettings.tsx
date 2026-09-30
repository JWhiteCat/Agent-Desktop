import { useCallback, useEffect, useState } from 'react'
import { isValidSkillName } from '@shared/agent-config'
import type { LocalSkillEntry, LocalSkillOrigin, LocalSkillReport, LocalTarget } from '@shared/local-config'
import { useT } from '../../lib/i18n'
import { errorText, toast } from '../../store'
import { emptySkillDraft, SkillForm, type SkillDraft } from '../AgentConfigSettings'
import { baseName, CLI_LABEL, CLI_ORDER, TargetPicker } from './LocalTarget'

interface Editing {
  draft: SkillDraft
  entry?: LocalSkillEntry
  hash?: string
  target: LocalTarget
}

export function LocalSkillSettings() {
  const t = useT()
  const [report, setReport] = useState<LocalSkillReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<Editing | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setReport(await window.api.localSkillList())
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (action: () => Promise<void>): Promise<boolean> => {
    try {
      await action()
      await load()
      return true
    } catch (err) {
      toast(errorText(err), 'error')
      await load()
      return false
    }
  }

  const originLabel = (entry: LocalSkillEntry) => {
    const labels: Record<LocalSkillOrigin, string> = {
      user: t('用户'),
      project: t('项目：{name}', { name: baseName(entry.projectPath ?? '') }),
      builtin: t('内置'),
      plugin: t('插件'),
      app: t('本应用')
    }
    return labels[entry.origin]
  }

  const edit = async (entry: LocalSkillEntry) => {
    try {
      const content = await window.api.localSkillRead(entry.id)
      setEditing({
        draft: { id: entry.id, name: content.name, description: content.description, enabled: entry.enabled, body: content.body },
        entry,
        hash: content.hash,
        target: { cli: entry.cli, scope: 'user' }
      })
    } catch (err) {
      toast(errorText(err), 'error')
    }
  }

  const row = (entry: LocalSkillEntry) => (
    <div key={entry.id} className="config-item">
      <input
        type="checkbox"
        className="toggle"
        checked={entry.enabled}
        disabled={entry.readonly}
        title={entry.readonly ? t('由 CLI 或本应用管理') : entry.enabled ? t('停用') : t('启用')}
        onChange={() => void run(() => window.api.localSkillToggle(entry.id, !entry.enabled))}
      />
      <div className="config-main">
        <div className="config-title">
          {entry.name}
          <span className="config-tag">{originLabel(entry)}</span>
        </div>
        <div className="config-sub" title={entry.dir}>
          {entry.description || t('没有描述')}
        </div>
      </div>
      {!entry.readonly && (
        <button className="btn small" type="button" onClick={() => void edit(entry)}>
          {t('编辑')}
        </button>
      )}
      {!window.api.isRemote && (
        <button className="btn small" type="button" onClick={() => void window.api.openPath(entry.dir)}>
          {t('打开目录')}
        </button>
      )}
      {!entry.readonly && (
        <button
          className="btn small"
          type="button"
          onClick={() => {
            if (!window.confirm(t('把 Skill「{name}」的目录 {path} 移到回收站？', { name: entry.name, path: entry.dir }))) return
            if (editing?.entry?.id === entry.id) setEditing(null)
            void run(() => window.api.localSkillDelete(entry.id))
          }}
        >
          {t('删除')}
        </button>
      )}
    </div>
  )

  const entries = report?.entries ?? []

  return (
    <div className="config-block">
      <div className="muted small">
        {t('列出 ~/.cursor/skills、~/.agents/skills、~/.codex/skills、~/.claude/skills 和已添加项目里的同名目录，以及 CLI 内置和插件 Skill。停用会把目录移到本应用的暂存区，启用时移回；删除会移到回收站。内置、插件和本应用创建的 Skill 在这里只读。')}
      </div>
      {report?.errors.map((error) => (
        <div key={error.file} className="config-error">
          {t('无法读取 {path}：{message}', { path: error.file, message: error.message })}
        </div>
      ))}
      {CLI_ORDER.map((cli) => {
        const list = entries.filter((entry) => entry.cli === cli)
        const own = list.filter((entry) => entry.origin !== 'builtin' && entry.origin !== 'plugin')
        const shipped = list.filter((entry) => entry.origin === 'builtin' || entry.origin === 'plugin')
        return (
          <div key={cli} className="config-block">
            <div className="config-group-title">{CLI_LABEL[cli]}</div>
            <div className="config-list">
              {own.map(row)}
              {own.length === 0 && <div className="empty-hint">{loading ? t('读取中…') : t('没有找到 Skill')}</div>}
            </div>
            {shipped.length > 0 && (
              <details className="config-details">
                <summary>{t('内置和插件（{count}）', { count: shipped.length })}</summary>
                <div className="config-list">{shipped.map(row)}</div>
              </details>
            )}
          </div>
        )
      })}
      {editing ? (
        <SkillForm
          draft={editing.draft}
          hideEnabled
          extra={
            editing.entry ? (
              <div className="muted small">
                {CLI_LABEL[editing.entry.cli]} · {editing.entry.dir}
              </div>
            ) : (
              <TargetPicker target={editing.target} onChange={(target) => setEditing({ ...editing, target })} />
            )
          }
          onChange={(draft) => setEditing({ ...editing, draft })}
          onCancel={() => setEditing(null)}
          onSave={async () => {
            const { draft, entry, hash, target } = editing
            const name = draft.name.trim()
            const error = !name ? t('请填写名称') : name !== entry?.name && !isValidSkillName(name) ? t('名称只能使用小写字母、数字和连字符') : !draft.description.trim() ? t('请填写描述') : undefined
            if (error) {
              toast(error, 'error')
              return
            }
            const req = { name, description: draft.description, body: draft.body }
            const ok = await run(() => window.api.localSkillSave(entry ? { ...req, id: entry.id, hash } : { ...req, target }))
            if (ok) setEditing(null)
          }}
        />
      ) : (
        <div className="row-gap wrap">
          <button className="btn" type="button" onClick={() => setEditing({ draft: emptySkillDraft(), target: { cli: 'cursor', scope: 'user' } })}>
            {t('添加 Skill')}
          </button>
          <button className="btn" type="button" disabled={loading} onClick={() => void load()}>
            {t('刷新')}
          </button>
        </div>
      )}
    </div>
  )
}
