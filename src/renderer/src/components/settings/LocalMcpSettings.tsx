import { useCallback, useEffect, useState } from 'react'
import type { LocalMcpEntry, LocalMcpReport, LocalTarget } from '@shared/local-config'
import { useT } from '../../lib/i18n'
import { errorText, toast } from '../../store'
import { emptyMcpDraft, mcpFromDraft, McpForm, pairLineError, toMcpDraft, type McpDraft } from '../AgentConfigSettings'
import { baseName, CLI_LABEL, CLI_ORDER, TargetPicker } from './LocalTarget'

interface Editing {
  draft: McpDraft
  entry?: LocalMcpEntry
  target: LocalTarget
}

export function LocalMcpSettings() {
  const t = useT()
  const [report, setReport] = useState<LocalMcpReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<Editing | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setReport(await window.api.localMcpList())
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

  const scopeLabel = (entry: LocalMcpEntry) => {
    if (entry.scope === 'user') return t('用户')
    const name = baseName(entry.projectPath ?? '')
    return entry.scope === 'local' ? t('本地：{name}', { name }) : t('项目：{name}', { name })
  }

  const entries = report?.entries ?? []

  return (
    <div className="config-block">
      <div className="muted small">
        {t('直接读写各 CLI 自己的配置：~/.cursor/mcp.json、~/.codex/config.toml、~/.claude.json，以及已添加项目里的 .cursor/mcp.json、.codex/config.toml、.mcp.json。Codex 用原生的 enabled 开关；Cursor 和 Claude 没有开关，停用的条目暂存在本应用里，启用时写回。每个文件第一次被修改前会备份为 .agent-desktop.bak。')}
      </div>
      {report?.errors.map((error) => (
        <div key={error.file} className="config-error">
          {t('无法读取 {path}：{message}', { path: error.file, message: error.message })}
        </div>
      ))}
      {CLI_ORDER.map((cli) => {
        const list = entries.filter((entry) => entry.cli === cli)
        return (
          <div key={cli} className="config-block">
            <div className="config-group-title">{CLI_LABEL[cli]}</div>
            <div className="config-list">
              {list.map((entry) => (
                <div key={entry.id} className="config-item">
                  <input
                    type="checkbox"
                    className="toggle"
                    checked={entry.enabled}
                    disabled={entry.readonly}
                    title={entry.enabled ? t('停用') : t('启用')}
                    onChange={() => void run(() => window.api.localMcpToggle(entry.id, !entry.enabled, entry.fileHash))}
                  />
                  <div className="config-main">
                    <div className="config-title">
                      {entry.name}
                      <span className="config-tag">{scopeLabel(entry)}</span>
                    </div>
                    <div className="config-sub" title={entry.file}>
                      {entry.transport === 'stdio' ? [entry.command, ...entry.args].join(' ') || t('未填写命令') : entry.url || t('未填写地址')}
                      {' · '}
                      {entry.note ?? entry.file}
                    </div>
                  </div>
                  {!entry.readonly && (
                    <button className="btn small" type="button" onClick={() => setEditing({ draft: toMcpDraft(entry), entry, target: { cli: entry.cli, scope: 'user' } })}>
                      {t('编辑')}
                    </button>
                  )}
                  {!window.api.isRemote && (
                    <button className="btn small" type="button" onClick={() => void window.api.openPath(entry.file)}>
                      {t('打开文件')}
                    </button>
                  )}
                  {!entry.readonly && (
                    <button
                      className="btn small"
                      type="button"
                      onClick={() => {
                        if (!window.confirm(t('从 {path} 删除 MCP 服务器「{name}」？', { name: entry.name, path: entry.file }))) return
                        if (editing?.entry?.id === entry.id) setEditing(null)
                        void run(() => window.api.localMcpDelete(entry.id, entry.fileHash))
                      }}
                    >
                      {t('删除')}
                    </button>
                  )}
                </div>
              ))}
              {list.length === 0 && <div className="empty-hint">{loading ? t('读取中…') : t('没有找到 MCP 服务器')}</div>}
            </div>
          </div>
        )
      })}
      {editing ? (
        <McpForm
          draft={editing.draft}
          extra={
            editing.entry ? (
              <div className="muted small">
                {CLI_LABEL[editing.entry.cli]} · {editing.entry.file}
              </div>
            ) : (
              <TargetPicker target={editing.target} onChange={(target) => setEditing({ ...editing, target })} />
            )
          }
          onChange={(draft) => setEditing({ ...editing, draft })}
          onCancel={() => setEditing(null)}
          onSave={async () => {
            const { draft, entry, target } = editing
            const server = mcpFromDraft(draft)
            const error = !server.name
              ? t('请填写名称')
              : draft.transport === 'stdio'
                ? !server.command ? t('请填写命令') : pairLineError(draft.envText, '=')
                : !server.url ? t('请填写地址') : pairLineError(draft.headersText, ':')
            if (error) {
              toast(error, 'error')
              return
            }
            const ok = await run(() => window.api.localMcpSave(entry ? { id: entry.id, fileHash: entry.fileHash, server } : { target, server }))
            if (ok) setEditing(null)
          }}
        />
      ) : (
        <div className="row-gap wrap">
          <button className="btn" type="button" onClick={() => setEditing({ draft: emptyMcpDraft(), target: { cli: 'cursor', scope: 'user' } })}>
            {t('添加服务器')}
          </button>
          <button className="btn" type="button" disabled={loading} onClick={() => void load()}>
            {t('刷新')}
          </button>
        </div>
      )}
    </div>
  )
}
