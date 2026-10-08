import { useState } from 'react'
import { normalizeGrokBotNames, validateGrokBotName } from '@shared/grokbot'
import { useT } from '../../lib/i18n'
import { errorText, toast, useStore } from '../../store'
import { IconX } from '../icons'
import { Field } from './Field'

/** Bot names the Grok Bot API cannot list. They are merged with the Grok Bot app's cached roster. */
export function GrokBotSettings() {
  const t = useT()
  const names = useStore((s) => s.app.settings.grokbotBots) ?? []
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')

  const save = async (next: string[]) => {
    try {
      await window.api.updateSettings({ grokbotBots: normalizeGrokBotNames(next) })
    } catch (err) {
      toast(errorText(err), 'error')
    }
  }

  const add = async () => {
    let name: string
    try {
      name = validateGrokBotName(draft)
    } catch (err) {
      setError(errorText(err))
      return
    }
    if (names.includes(name)) {
      setError(t('「{name}」已在列表中', { name }))
      return
    }
    await save([...names, name])
    setDraft('')
    setError('')
  }

  return (
    <>
      <Field
        label={t('手动添加的 Bot')}
        desc={t('Grok Bot API 不能列出 Bot。这里的名称会和 Grok Bot 桌面端缓存的列表合并显示。请填写已有 Bot 的准确名称：Grok Bot 按名称查找，名称不存在时，打开它会新建一个同名 Bot。')}
      >
        <div className="grokbot-manual">
          <div className="grokbot-manual-add">
            <input
              className="input"
              value={draft}
              placeholder={t('Bot 名称')}
              aria-label={t('Bot 名称')}
              onChange={(e) => {
                setDraft(e.target.value)
                setError('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void add()
              }}
            />
            <button type="button" className="btn" disabled={!draft.trim()} onClick={() => void add()}>
              {t('添加')}
            </button>
          </div>
          {error && <div className="grokbot-error">{error}</div>}
          {names.length ? (
            <ul className="grokbot-manual-list">
              {names.map((name) => (
                <li key={name}>
                  <span>{name}</span>
                  <button
                    type="button"
                    className="icon-btn tiny"
                    title={t('从手动列表移除')}
                    aria-label={t('从手动列表移除')}
                    onClick={() => void save(names.filter((n) => n !== name))}
                  >
                    <IconX size={12} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted small">{t('还没有手动添加的 Bot')}</div>
          )}
        </div>
      </Field>
      <div className="muted small grokbot-settings-note">
        {t('Bot 发来的文件只能从 Grok Bot 桌面端在这台电脑上的本地缓存读取（未公开的格式），Grok Bot 更新后可能失效；手动添加的 Bot 不显示文件内容。')}
      </div>
    </>
  )
}
