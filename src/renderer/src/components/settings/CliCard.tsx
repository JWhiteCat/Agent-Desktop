import { useEffect, useState } from 'react'
import type { CliInfo, CliProvider } from '@shared/types'
import { useT } from '../../lib/i18n'
import { errorText, loadModels, toast } from '../../store'
import { IconRefresh, Spinner } from '../icons'
import { Field } from './Field'

export function CliCard({
  provider,
  pathValue,
  pathPlaceholder,
  pathDesc,
  keyValue,
  keyPlaceholder,
  keyDesc,
  missing,
  install,
  onPath,
  onKey
}: {
  provider: CliProvider
  pathValue: string
  pathPlaceholder: string
  pathDesc: string
  keyValue: string
  keyPlaceholder: string
  keyDesc: string
  missing: string
  install: string
  onPath: (value: string) => void | Promise<void>
  onKey: (value: string) => void | Promise<void>
}) {
  const t = useT()
  const [info, setInfo] = useState<CliInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [updateResult, setUpdateResult] = useState<{ text: string; error: boolean } | null>(null)
  const [pathDraft, setPathDraft] = useState(pathValue)
  const [keyDraft, setKeyDraft] = useState(keyValue)

  const check = async () => {
    setChecking(true)
    try {
      setInfo(await window.api.cliInfo(provider))
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setChecking(false)
    }
  }

  const save = async (onSave: (value: string) => void | Promise<void>, value: string) => {
    setSaving(true)
    setUpdateResult(null)
    try {
      await onSave(value)
      await check()
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    void check()
  }, [provider, t])

  return (
    <>
      <div className="cli-card">
        {checking && !info ? (
          <div className="row-gap">
            <Spinner /> <span className="muted">{t('正在检测…')}</span>
          </div>
        ) : info?.found ? (
          <>
            <div className="row-gap">
              <span className="ok-dot" /> <strong>{info.bundled ? (provider === 'claude' ? t('使用内置 Claude') : t('使用内置 Codex')) : t('已找到')}</strong>{' '}
              <span className="muted small">{info.version}</span>
            </div>
            <div className="muted small mono break">{info.path}</div>
            {info.status && <pre className="cli-status">{info.status}</pre>}
          </>
        ) : (
          <>
            <div className="row-gap">
              <span className="err-dot" /> <strong>{missing}</strong>
            </div>
            <div className="muted small">{install}</div>
          </>
        )}
        <div className="row-gap wrap">
          <button className="btn" onClick={() => void check()} disabled={checking || updating || saving}>
            <IconRefresh size={13} className={checking ? 'spin' : ''} /> {t('重新检测')}
          </button>
          <button
            className="btn"
            disabled={!info?.found || loggingIn || updating || saving}
            onClick={async () => {
              setLoggingIn(true)
              try {
                const out = await window.api.login(provider)
                toast(out.split('\n').pop() || t('登录流程已结束'))
                void check()
              } catch (err) {
                toast(errorText(err), 'error')
              } finally {
                setLoggingIn(false)
              }
            }}
          >
            {loggingIn ? <Spinner size={12} /> : null} {t('登录 / 重新登录')}
          </button>
          <button
            className="btn"
            disabled={!info?.found || info.bundled || checking || loggingIn || updating || saving || pathDraft !== pathValue}
            title={info?.bundled ? t('内置 CLI 随应用更新；安装独立 CLI 后可在这里更新') : t('更新此 CLI')}
            onClick={async () => {
              setUpdating(true)
              setUpdateResult(null)
              try {
                const out = await window.api.updateCli(provider)
                setUpdateResult({ text: out || t('CLI 更新完成'), error: false })
                toast(t('CLI 更新完成'))
                void loadModels(true, provider)
              } catch (err) {
                const text = errorText(err)
                setUpdateResult({ text, error: true })
                toast(text, 'error')
              } finally {
                await check()
                setUpdating(false)
              }
            }}
          >
            {updating ? <Spinner size={12} /> : null} {updating ? t('更新中…') : t('更新')}
          </button>
        </div>
        {info?.bundled && <div className="muted small">{t('内置 CLI 随应用更新；安装独立 CLI 后可在这里更新。')}</div>}
        {updateResult && <pre className="cli-status" role={updateResult.error ? 'alert' : 'status'}>{updateResult.text}</pre>}
      </div>
      <Field label="API Key" desc={keyDesc}>
        <input
          className="input"
          type="password"
          disabled={updating || saving}
          value={keyDraft}
          placeholder={keyPlaceholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKeyDraft(e.target.value)}
          onBlur={() => {
            if (keyDraft !== keyValue) {
              void save(onKey, keyDraft)
            }
          }}
        />
      </Field>
      <Field label={t('CLI 路径')} desc={pathDesc}>
        <input
          className="input"
          disabled={updating || saving}
          value={pathDraft}
          placeholder={pathPlaceholder}
          onChange={(e) => setPathDraft(e.target.value)}
          onBlur={() => {
            if (pathDraft !== pathValue) {
              void save(onPath, pathDraft)
            }
          }}
        />
      </Field>
    </>
  )
}
