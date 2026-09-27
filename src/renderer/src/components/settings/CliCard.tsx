import { useEffect, useState } from 'react'
import type { CliInfo, CliProvider } from '@shared/types'
import { errorText, toast } from '../../store'
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
  const [info, setInfo] = useState<CliInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [pathDraft, setPathDraft] = useState(pathValue)
  const [keyDraft, setKeyDraft] = useState(keyValue)

  const check = async () => {
    setChecking(true)
    try {
      setInfo(await window.api.cliInfo(provider))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void check()
  }, [provider])

  return (
    <>
      <div className="cli-card">
        {checking && !info ? (
          <div className="row-gap">
            <Spinner /> <span className="muted">正在检测…</span>
          </div>
        ) : info?.found ? (
          <>
            <div className="row-gap">
              <span className="ok-dot" /> <strong>{info.bundled ? (provider === 'claude' ? '使用内置 Claude' : '使用内置 Codex') : '已找到'}</strong>{' '}
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
          <button className="btn" onClick={() => void check()} disabled={checking}>
            <IconRefresh size={13} className={checking ? 'spin' : ''} /> 重新检测
          </button>
          <button
            className="btn"
            disabled={!info?.found || loggingIn}
            onClick={async () => {
              setLoggingIn(true)
              try {
                const out = await window.api.login(provider)
                toast(out.split('\n').pop() || '登录流程已结束')
                void check()
              } catch (err) {
                toast(errorText(err), 'error')
              } finally {
                setLoggingIn(false)
              }
            }}
          >
            {loggingIn ? <Spinner size={12} /> : null} 登录 / 重新登录
          </button>
        </div>
      </div>
      <Field label="API Key" desc={keyDesc}>
        <input
          className="input"
          type="password"
          value={keyDraft}
          placeholder={keyPlaceholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKeyDraft(e.target.value)}
          onBlur={() => {
            if (keyDraft !== keyValue) {
              void Promise.resolve(onKey(keyDraft)).then(() => check())
            }
          }}
        />
      </Field>
      <Field label="CLI 路径" desc={pathDesc}>
        <input
          className="input"
          value={pathDraft}
          placeholder={pathPlaceholder}
          onChange={(e) => setPathDraft(e.target.value)}
          onBlur={() => {
            if (pathDraft !== pathValue) {
              void Promise.resolve(onPath(pathDraft)).then(() => check())
            }
          }}
        />
      </Field>
    </>
  )
}
