import { t as translate } from '@shared/i18n'
import { Notification, type BrowserWindow } from 'electron'
import type { RunFinished } from './sessions'

export function notifyRunFinished(
  info: RunFinished,
  opts: {
    enabled: boolean
    getWindow(): BrowserWindow | null
    send(channel: string, payload: unknown): void
  }
): void {
  if (info.stopped || !opts.enabled || !Notification.isSupported()) return
  const body = (info.failed ? (info.preview ? translate('未能完成：{preview}', { preview: info.preview }) : translate('任务未能完成')) : info.preview || translate('任务已完成')).slice(0, 180)
  const notification = new Notification({ title: info.title || 'Agent Desktop', body })
  notification.on('click', () => {
    const win = opts.getWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    opts.send('thread:focus', info.threadId)
  })
  notification.show()
}
