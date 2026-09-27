import { useState } from 'react'
import type { CliProvider, Settings } from '@shared/types'
import { defaultModelFor, favoritesFor, modelForChat } from '../../lib/model-prefs'
import { loadModels, setDefaultModel, useStore } from '../../store'
import { McpSettings, SkillSettings } from '../AgentConfigSettings'
import { MODES } from '../Composer'
import { ModelPicker } from '../ModelPicker'
import { Modal } from '../Modal'
import { CliCard } from './CliCard'
import { FavoriteModels } from './FavoriteModels'
import { Field } from './Field'
import { RemoteSettings } from './RemoteSettings'
import { UsageSettings } from './UsageSettings'

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

function ModelCliSettings({ provider }: { provider: CliProvider }) {
  const settings = useStore((s) => s.app.settings)
  const models = useStore((s) => s.modelsByCli[provider] ?? (provider === 'cursor' ? s.models : []))
  return (
    <>
      <FavoriteModels provider={provider} />
      <Field label="默认模型" desc="每个项目会记住自己上次在这个 CLI 里选的模型。这里只给还没单独选过的项目用。勾选常用模型后，这里也只列出常用模型。">
        <ModelPicker
          cli={provider}
          value={modelForChat(models, favoritesFor(settings, provider), defaultModelFor(settings, provider))}
          onChange={(model) => setDefaultModel(model, provider)}
        />
      </Field>
    </>
  )
}

export function SettingsDialog({ onClose, onOpenImport }: { onClose: () => void; onOpenImport: () => void }) {
  const settings = useStore((s) => s.app.settings)
  const cli = settings.cliProvider === 'codex' ? 'codex' : 'cursor'
  const [modelCli, setModelCli] = useState<CliProvider>(cli)
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
          <div className="usage-periods" role="tablist" aria-label="模型来源">
            {(['cursor', 'codex'] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={modelCli === id}
                className={`usage-period ${modelCli === id ? 'active' : ''}`}
                onClick={() => setModelCli(id)}
              >
                {id === 'cursor' ? 'Cursor' : 'Codex'}
              </button>
            ))}
          </div>
          <ModelCliSettings provider={modelCli} />
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
