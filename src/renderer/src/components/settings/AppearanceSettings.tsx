import { useState } from 'react'
import type { Settings } from '@shared/types'
import { useT } from '../../lib/i18n'
import { errorText, toast, useStore } from '../../store'
import { Field } from './Field'
import { FontSettings } from './FontSettings'
import { ToolbarSettings } from './ToolbarSettings'

const PANELS = [
  { id: 'appearance', label: '外观' },
  { id: 'toolbar', label: '顶部按钮' },
  { id: 'history', label: '历史' }
] as const
const THEMES = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'system', label: '跟随系统' }
] as const

export function AppearanceSettings({ onOpenImport }: { onOpenImport: () => void }) {
  const t = useT()
  const settings = useStore((s) => s.app.settings)
  const [panel, setPanel] = useState<(typeof PANELS)[number]['id']>('appearance')
  const update = (patch: Partial<Settings>) => {
    void window.api.updateSettings(patch).catch((error) => toast(errorText(error), 'error'))
  }

  return (
    <section className="appearance-settings">
      <header className="appearance-heading">
        <h2>{t('外观与历史')}</h2>
        <p>{t('调整界面风格，管理会话工具与历史记录。')}</p>
      </header>
      <nav className="appearance-tabs" aria-label={t('外观与历史分类')}>
        {PANELS.filter((item) => item.id !== 'toolbar' || !window.api.isRemote).map((item) => (
          <button key={item.id} type="button" aria-current={panel === item.id ? 'page' : undefined}
            className={panel === item.id ? 'active' : ''} onClick={() => setPanel(item.id)}>
            {t(item.label)}
          </button>
        ))}
      </nav>

      {panel === 'appearance' && <div className="appearance-panel">
        <section className="appearance-group" aria-labelledby="appearance-interface">
          <h3 id="appearance-interface">{t('界面')}</h3>
          <fieldset className="theme-setting">
            <legend>{t('主题')}</legend>
            <div className="theme-options">
              {THEMES.map((theme) => <label key={theme.id} className={`theme-option ${settings.theme === theme.id ? 'selected' : ''}`}>
                <input type="radio" name="appearance-theme" value={theme.id} checked={settings.theme === theme.id}
                  onChange={() => update({ theme: theme.id })} />
                <span className={`theme-preview theme-preview-${theme.id}`} aria-hidden="true">
                  <span className="theme-preview-sidebar" />
                  <span className="theme-preview-content"><i /><i /><i /></span>
                </span>
                <span className="theme-option-label">{t(theme.label)}<span className="theme-option-check" aria-hidden="true" /></span>
              </label>)}
            </div>
          </fieldset>
          <Field label={t('语言')}>
            <select className="input" aria-label={t('语言')} value={settings.language ?? 'system'}
              onChange={(event) => update({ language: event.target.value as Settings['language'] })}>
              <option value="system">{t('跟随系统')}</option>
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
            </select>
          </Field>
        </section>
        <section className="appearance-group" aria-labelledby="appearance-text">
          <h3 id="appearance-text">{t('文字显示')}</h3>
          <FontSettings />
        </section>
      </div>}

      {panel === 'toolbar' && !window.api.isRemote && <div className="appearance-panel"><ToolbarSettings /></div>}

      {panel === 'history' && <div className="appearance-panel">
        <section className="appearance-group" aria-labelledby="appearance-history">
          <h3 id="appearance-history">{t('会话记录')}</h3>
          <Field label={t('显示已归档对话')} desc={t('在侧边栏中显示已归档的对话。')}>
            <input type="checkbox" className="toggle" aria-label={t('显示已归档对话')} checked={settings.showArchived}
              onChange={(event) => update({ showArchived: event.target.checked })} />
          </Field>
        </section>
        <section className="appearance-group history-import" aria-labelledby="appearance-import">
          <h3 id="appearance-import">{t('CLI 历史会话')}</h3>
          <p>{t('将本机 CLI 中的历史会话导入，按工作目录自动归入项目。')}</p>
          <div className="history-sources">
            <div><span>Cursor</span><code>~/.cursor/chats</code></div>
            <div><span>Codex</span><code>~/.codex/sessions</code></div>
            <div><span>Claude Code</span><code>~/.claude/projects</code></div>
          </div>
          <button type="button" className="btn" onClick={onOpenImport}>{t('导入…')}</button>
        </section>
      </div>}
    </section>
  )
}
