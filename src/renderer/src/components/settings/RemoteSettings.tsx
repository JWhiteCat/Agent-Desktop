import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { RemoteInfo } from '@shared/types'
import { useT } from '../../lib/i18n'
import { errorText, toast, useStore } from '../../store'
import { Field } from './Field'

export function RemoteSettings() {
  const t = useT()
  const settings = useStore((s) => s.app.settings)
  const view = useStore((s) => s.view)
  const [info, setInfo] = useState<RemoteInfo | null>(null)
  const [port, setPort] = useState(String(settings.remotePort))
  const [pubUser, setPubUser] = useState(settings.remotePublicUser)
  const [pubHost, setPubHost] = useState(settings.remotePublicHost)
  const [sshPort, setSshPort] = useState(String(settings.remotePublicSshPort))
  const [pubPort, setPubPort] = useState(String(settings.remotePublicPort))
  const [urlIndex, setUrlIndex] = useState(0)
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => {
      window.api.remoteInfo().then((i) => alive && setInfo(i), () => {})
    }
    load()
    const timer = settings.remotePublicEnabled ? setInterval(load, 1500) : undefined
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [
    settings.remoteEnabled,
    settings.remotePort,
    settings.remoteToken,
    settings.remotePublicEnabled,
    settings.remotePublicUser,
    settings.remotePublicHost,
    settings.remotePublicSshPort,
    settings.remotePublicPort
  ])

  useEffect(() => {
    if (!info?.publicUrl) return
    const index = info.urls.indexOf(info.publicUrl)
    if (index >= 0) setUrlIndex(index)
  }, [info?.publicUrl])

  const hash = view.kind === 'thread' ? `#thread=${view.id}` : view.projectId ? `#project=${view.projectId}` : ''
  const base = info?.urls[urlIndex] ?? info?.urls[0]
  const link = base ? base + hash : ''

  useEffect(() => {
    if (!link) {
      setQr('')
      return
    }
    let alive = true
    QRCode.toDataURL(link, { margin: 1, width: 220 }).then((d) => alive && setQr(d), () => {})
    return () => {
      alive = false
    }
  }, [link])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Field label={t('启用远程控制')} desc={t('在局域网内提供网页，手机与电脑连同一 Wi-Fi 后扫码即可操作。持有链接即可完全控制本应用，请勿外传')}>
        <input
          type="checkbox"
          className="toggle"
          checked={settings.remoteEnabled}
          disabled={busy}
          onChange={(e) => run(() => window.api.updateSettings({ remoteEnabled: e.target.checked }))}
        />
      </Field>
      <Field label={t('端口')}>
        <input
          className="input"
          inputMode="numeric"
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
          onBlur={() => {
            if (port === String(settings.remotePort)) return
            run(() =>
              window.api.updateSettings({ remotePort: Number(port) }).catch((err) => {
                setPort(String(settings.remotePort))
                throw err
              })
            )
          }}
        />
      </Field>
      <Field
        label={t('公网访问')}
        desc={t('经 SSH 把网页挂到服务器的同一个端口。多台电脑可以同时开着，每台有自己的链接。链接是明文 HTTP，持有者可完全控制本应用')}
      >
        <input
          type="checkbox"
          className="toggle"
          checked={settings.remotePublicEnabled}
          disabled={busy || (!settings.remoteEnabled && !settings.remotePublicEnabled)}
          onChange={(e) => run(() => window.api.updateSettings({ remotePublicEnabled: e.target.checked }))}
        />
      </Field>
      <Field label={t('SSH 用户')}>
        <input
          className="input"
          value={pubUser}
          disabled={busy}
          onChange={(e) => setPubUser(e.target.value)}
          onBlur={() => {
            if (pubUser === settings.remotePublicUser) return
            run(() =>
              window.api.updateSettings({ remotePublicUser: pubUser }).catch((err) => {
                setPubUser(settings.remotePublicUser)
                throw err
              })
            )
          }}
        />
      </Field>
      <Field label={t('服务器地址')}>
        <input
          className="input"
          value={pubHost}
          disabled={busy}
          spellCheck={false}
          onChange={(e) => setPubHost(e.target.value.trim())}
          onBlur={() => {
            if (pubHost === settings.remotePublicHost) return
            run(() =>
              window.api.updateSettings({ remotePublicHost: pubHost }).catch((err) => {
                setPubHost(settings.remotePublicHost)
                throw err
              })
            )
          }}
        />
      </Field>
      <Field label={t('SSH 端口')}>
        <input
          className="input"
          inputMode="numeric"
          value={sshPort}
          disabled={busy}
          onChange={(e) => setSshPort(e.target.value.replace(/\D/g, ''))}
          onBlur={() => {
            if (sshPort === String(settings.remotePublicSshPort)) return
            run(() =>
              window.api.updateSettings({ remotePublicSshPort: Number(sshPort) }).catch((err) => {
                setSshPort(String(settings.remotePublicSshPort))
                throw err
              })
            )
          }}
        />
      </Field>
      <Field label={t('公网端口')}>
        <input
          className="input"
          inputMode="numeric"
          value={pubPort}
          disabled={busy}
          onChange={(e) => setPubPort(e.target.value.replace(/\D/g, ''))}
          onBlur={() => {
            if (pubPort === String(settings.remotePublicPort)) return
            run(() =>
              window.api.updateSettings({ remotePublicPort: Number(pubPort) }).catch((err) => {
                setPubPort(String(settings.remotePublicPort))
                throw err
              })
            )
          }}
        />
      </Field>
      {info?.error && <div className="remote-error small">{info.errorMessage ? t(info.errorMessage.source, info.errorMessage.params) : info.error}</div>}
      {settings.remotePublicEnabled && info?.publicStatus === 'connecting' && <div className="muted small">{t('正在连接公网…')}</div>}
      {settings.remotePublicEnabled && info?.publicStatus === 'up' && <div className="muted small">{t('公网已连接')}</div>}
      {info?.publicError && <div className="remote-error small">{info.publicErrorMessage ? t(info.publicErrorMessage.source, info.publicErrorMessage.params) : info.publicError}</div>}
      {settings.remoteEnabled && info?.running && (
        <div className="remote-card">
          {qr ? <img className="remote-qr" src={qr} alt={t('远程控制二维码')} /> : <div className="remote-qr" />}
          <div className="remote-detail">
            {info.urls.length === 0 ? (
              <div className="muted small">{t('未检测到局域网地址，请确认电脑已连接 Wi-Fi 或有线网络')}</div>
            ) : (
              <>
                {info.urls.length > 1 && (
                  <select className="input" value={urlIndex} onChange={(e) => setUrlIndex(Number(e.target.value))}>
                    {info.urls.map((u, i) => (
                      <option key={u} value={i}>
                        {(() => {
                          const parsed = new URL(u)
                          return parsed.pathname === '/' ? parsed.host : `${parsed.host}${parsed.pathname}`
                        })()}
                      </option>
                    ))}
                  </select>
                )}
                <div className="mono small break remote-link">{link}</div>
                <div className="muted small">{view.kind === 'thread' ? t('扫码后打开当前正在查看的对话') : t('扫码后打开当前正在查看的项目')}</div>
              </>
            )}
            <div className="row-gap wrap">
              <button className="btn" disabled={!link} onClick={() => navigator.clipboard.writeText(link).then(() => toast(t('已复制链接')))}>
                {t('复制链接')}
              </button>
              <button className="btn" disabled={busy} onClick={() => run(async () => setInfo(await window.api.resetRemoteToken()))}>
                {t('重置链接')}
              </button>
            </div>
            <div className="muted small">{t('重置后旧链接和已连接的手机会立即失效')}</div>
          </div>
        </div>
      )}
    </>
  )
}
