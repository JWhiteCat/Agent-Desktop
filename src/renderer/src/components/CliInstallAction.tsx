import { useEffect, useState } from 'react'
import { cliTitle, type CliInstallStatus, type CliProvider } from '@shared/types'
import { useT } from '../lib/i18n'
import { errorText, loadModels, toast } from '../store'
import { Spinner } from './icons'

export function useCliInstallStatus(provider?: CliProvider, threadId?: string) {
  const key = `${provider ?? ''}:${threadId ?? ''}`
  const [checked, setChecked] = useState<{ key: string; status: CliInstallStatus }>()
  useEffect(() => {
    if (!provider || !window.api.cliInstallStatus) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      let delay = 1_500
      try {
        const status = await window.api.cliInstallStatus(provider, threadId)
        if (stopped) return
        delay = status.phase ? 350 : status.source ? 4_000 : 1_500
        setChecked((previous) => previous?.key === key && JSON.stringify(previous.status) === JSON.stringify(status) ? previous : { key, status })
      } catch {
        // Keep the last detection across temporary remote disconnections.
      } finally {
        if (!stopped) timer = setTimeout(refresh, delay)
      }
    }
    void refresh()
    return () => { stopped = true; clearTimeout(timer) }
  }, [key, provider, threadId])
  return checked?.key === key ? checked.status : undefined
}

export function CliInstallAction({ provider, threadId, status, onInstalled, offerLogin = false }: {
  provider: CliProvider
  threadId?: string
  status?: CliInstallStatus
  onInstalled?: () => void
  offerLogin?: boolean
}) {
  const t = useT()
  const [installing, setInstalling] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [error, setError] = useState('')
  if (!status || (status.source && !status.phase && !installing && !(offerLogin && installed))) return null
  const running = installing || !!status.phase
  const progress = status.phase === 'verifying' ? t('正在校验 CLI…')
    : status.phase === 'installing' ? t('正在安装 CLI…')
      : status.total && status.received !== undefined
        ? t('正在下载 CLI… {percent}%', { percent: Math.min(100, Math.floor(status.received / status.total * 100)) })
        : t('正在下载 CLI…')
  const unavailable = status.unavailable === 'invalid-path' ? t('CLI 路径无效，请在「设置 → CLI」中修复或清除路径。')
      : status.unavailable === 'platform' ? t('此平台暂不支持应用内安装。') : undefined

  return (
    <div className="cli-install-notice">
      {running ? <span className="row-gap" role="status"><Spinner size={13} /> {progress}</span>
        : unavailable ? <span>{unavailable}</span>
          : installed && offerLogin ? (
            <>
              <span role="status">{t('{name} 已安装', { name: cliTitle(provider) })}</span>
              <button type="button" className="btn" disabled={loggingIn} onClick={async () => {
                setLoggingIn(true)
                setError('')
                try {
                  const result = await window.api.login(provider, threadId)
                  toast(result.split('\n').pop() || t('登录流程已结束'))
                  void loadModels(true, provider)
                  setInstalled(false)
                } catch (err) {
                  setError(errorText(err))
                } finally {
                  setLoggingIn(false)
                }
              }}>{loggingIn ? <Spinner size={13} /> : null} {t('登录 / 重新登录')}</button>
            </>
          ) : (
            <button type="button" className="btn" onClick={async () => {
              setInstalling(true)
              setError('')
              try {
                await window.api.installCli(provider, threadId)
                setInstalled(true)
                void loadModels(true, provider)
                onInstalled?.()
              } catch (err) {
                setError(errorText(err))
              } finally {
                setInstalling(false)
              }
            }}>{t('安装 {name}', { name: cliTitle(provider) })}</button>
          )}
      {!running && (error || status.error) && <span className="attachment-error" role="alert">{error || status.error}</span>}
    </div>
  )
}
