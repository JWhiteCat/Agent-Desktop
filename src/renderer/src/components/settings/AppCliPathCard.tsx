import { useEffect, useState } from 'react'
import type { AppCliPathStatus } from '@shared/types'
import { useT } from '../../lib/i18n'
import { errorText, toast } from '../../store'
import { IconRefresh, Spinner } from '../icons'
import { Field } from './Field'

export function AppCliPathCard() {
  const t = useT()
  const [status, setStatus] = useState<AppCliPathStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    setLoading(true)
    try {
      setStatus(await window.api.appCliPathStatus())
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const install = async () => {
    setBusy(true)
    try {
      const next = await window.api.installAppCliToPath()
      setStatus(next)
      toast(t('已将 agent-desktop 和 agd 安装到 PATH，新开终端生效'))
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const uninstall = async () => {
    setBusy(true)
    try {
      const next = await window.api.uninstallAppCliFromPath()
      setStatus(next)
      toast(t('已从 PATH 移除 agent-desktop 和 agd'))
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast(t('已复制'))
    } catch {
      toast(t('复制失败'), 'error')
    }
  }

  return (
    <Field
      label={t('本应用命令行工具（agent-desktop / agd）')}
      desc={t('在终端控制当前运行的桌面端（实时同步界面）；桌面端未运行时自动无头执行，共享配置、Skill 与历史记录。')}
    >
      <div className="cli-card">
        {loading && !status ? (
          <div className="row-gap">
            <Spinner /> <span className="muted">{t('正在检测…')}</span>
          </div>
        ) : status ? (
          <>
            <div className="row-gap">
              <span className={status.state === 'installed' ? 'ok-dot' : 'err-dot'} />
              <strong>
                {status.state === 'installed'
                  ? t('已安装到 PATH')
                  : status.state === 'stale'
                    ? t('PATH 路径已失效')
                    : status.state === 'unsupported'
                      ? t('当前环境暂不可安装')
                      : t('未安装到 PATH')}
              </strong>
              <span className="muted small mono">{status.commands.join(' / ')}</span>
            </div>
            {status.targetPath && (
              <div className="muted small mono break">{status.targetPath}</div>
            )}
            {status.error && (
              <div className="muted small">{status.error}</div>
            )}
            {status.state === 'installed' && status.pathSnippet && (
              <div className="muted small">
                {t('当前 Shell 的 PATH 尚未包含此目录，可将以下配置加入 ~/.zshrc 或 ~/.bashrc：')}
                <pre className="cli-status">{status.pathSnippet}</pre>
              </div>
            )}
            {status.isPortable && (
              <div className="muted small">{t('便携版或 AppImage 移动文件位置后，需要在此重新安装。')}</div>
            )}
            <div className="row-gap wrap">
              {status.supported && status.state !== 'installed' && (
                <button type="button" className="btn primary" disabled={busy || loading} onClick={() => void install()}>
                  {busy ? <Spinner /> : null} {status.state === 'stale' ? t('重新安装到 PATH') : t('安装命令到 PATH')}
                </button>
              )}
              {status.supported && (status.state === 'installed' || status.state === 'stale') && (
                <button type="button" className="btn" disabled={busy || loading} onClick={() => void uninstall()}>
                  {t('从 PATH 移除')}
                </button>
              )}
              {status.state === 'installed' && (
                <button type="button" className="btn" disabled={busy} onClick={() => void copy('agd status')}>
                  {t('复制验证命令')}
                </button>
              )}
              {status.pathSnippet && (
                <button type="button" className="btn" disabled={busy} onClick={() => void copy(status.pathSnippet!)}>
                  {t('复制 PATH 配置')}
                </button>
              )}
              <button type="button" className="btn" disabled={busy || loading} onClick={() => void refresh()}>
                <IconRefresh size={13} className={loading ? 'spin' : ''} /> {t('重新检测')}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </Field>
  )
}
