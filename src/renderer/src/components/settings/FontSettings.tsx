import { useEffect, useRef, useState } from 'react'
import { DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE, normalizeFontFamily, normalizeFontSize } from '@shared/appearance'
import type { Settings } from '@shared/types'
import { useT } from '../../lib/i18n'
import { errorText, toast, useStore } from '../../store'
import { Field } from './Field'

const FONT_FAMILIES = ['Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Source Han Sans SC', 'Arial', 'Georgia']

export function FontSettings() {
  const t = useT()
  const fontFamily = useStore((s) => normalizeFontFamily(s.app.settings.fontFamily))
  const fontSize = useStore((s) => normalizeFontSize(s.app.settings.fontSize))
  const [custom, setCustom] = useState(() => !!fontFamily && !FONT_FAMILIES.includes(fontFamily))
  const [familyDraft, setFamilyDraft] = useState(fontFamily)
  const [sizeDraft, setSizeDraft] = useState(String(fontSize))
  const sizeEditing = useRef(false)

  useEffect(() => {
    setCustom(!!fontFamily && !FONT_FAMILIES.includes(fontFamily))
    setFamilyDraft(fontFamily)
  }, [fontFamily])
  useEffect(() => {
    // Delayed settings broadcasts must not replace a partially typed size such as "20.".
    if (!sizeEditing.current) setSizeDraft(String(fontSize))
  }, [fontSize])

  const save = (patch: Partial<Settings>) => {
    void window.api.updateSettings(patch).catch((err) => toast(errorText(err), 'error'))
  }
  const saveFamily = () => {
    const next = normalizeFontFamily(familyDraft)
    setFamilyDraft(next)
    setCustom(!!next && !FONT_FAMILIES.includes(next))
    if (next !== fontFamily) save({ fontFamily: next })
  }
  const saveSize = () => {
    const next = sizeDraft.trim() ? normalizeFontSize(Number(sizeDraft)) : fontSize
    setSizeDraft(String(next))
    if (next !== fontSize) save({ fontSize: next })
  }

  return (
    <>
      <Field label={t('字体')} desc={t('用于界面和聊天内容，代码保留等宽字体。未安装的字体会回退到系统字体。')}>
        <div className="font-settings-control">
          <select
            className="input"
            aria-label={t('字体')}
            value={custom ? 'custom' : fontFamily}
            onChange={(e) => {
              const value = e.target.value
              setCustom(value === 'custom')
              if (value === 'custom') setFamilyDraft(fontFamily)
              else save({ fontFamily: value })
            }}
          >
            <option value="">{t('系统默认')}</option>
            {FONT_FAMILIES.map((family) => <option key={family} value={family}>{family}</option>)}
            <option value="custom">{t('自定义字体…')}</option>
          </select>
          {custom && (
            <input
              className="input"
              aria-label={t('自定义字体名称')}
              placeholder={t('输入已安装的字体名称')}
              maxLength={100}
              value={familyDraft}
              onChange={(e) => setFamilyDraft(e.target.value)}
              onBlur={saveFamily}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            />
          )}
        </div>
      </Field>
      <Field label={t('字号')} desc={t('界面、聊天和代码按比例调整，立即生效并自动保存。默认 {size} px。', { size: DEFAULT_FONT_SIZE })}>
        <div className="font-settings-control">
          <div className="row-gap">
            <input
              className="input font-size-input"
              type="number"
              aria-label={t('字号')}
              min={MIN_FONT_SIZE}
              max={MAX_FONT_SIZE}
              step={0.5}
              value={sizeDraft}
              onFocus={() => { sizeEditing.current = true }}
              onChange={(e) => {
                setSizeDraft(e.target.value)
                const value = e.target.valueAsNumber
                if (value >= MIN_FONT_SIZE && value <= MAX_FONT_SIZE && value * 2 === Math.round(value * 2)) save({ fontSize: value })
              }}
              onBlur={() => {
                sizeEditing.current = false
                saveSize()
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            />
            <span className="muted">px</span>
          </div>
          <button className="btn" onClick={() => {
            setCustom(false)
            setFamilyDraft('')
            setSizeDraft(String(DEFAULT_FONT_SIZE))
            save({ fontFamily: '', fontSize: DEFAULT_FONT_SIZE })
          }}>{t('恢复默认字体与字号')}</button>
        </div>
      </Field>
    </>
  )
}
