import { app, dialog, type BrowserWindow, type Event, type MessageBoxOptions } from 'electron'
import { t } from '@shared/i18n'

interface Options {
  getActiveCount(): number
  getWindow(): BrowserWindow | null
  onQuit(): void
}

/** Confirm before either closing the last desktop window or starting exit cleanup. */
export class QuitConfirmation {
  private state: 'idle' | 'confirming' | 'approved' = 'idle'
  private cleanedUp = false

  constructor(private readonly options: Options) {
    app.on('before-quit', (event) => {
      if (!this.allowQuit(event)) return
      this.state = 'approved'
      if (this.cleanedUp) return
      this.cleanedUp = true
      this.options.onQuit()
    })
  }

  watchWindow(win: BrowserWindow): void {
    // macOS keeps running after its last window closes; only an actual quit stops tasks.
    if (process.platform === 'darwin') return
    win.on('close', (event) => { this.allowQuit(event) })
  }

  private allowQuit(event: Event): boolean {
    if (this.state === 'approved') return true
    if (this.state === 'confirming') {
      event.preventDefault()
      return false
    }
    const count = this.options.getActiveCount()
    if (count === 0) return true
    event.preventDefault()
    this.state = 'confirming'
    void this.confirm(count)
    return false
  }

  private async confirm(count: number): Promise<void> {
    let response: number
    try {
      const options: MessageBoxOptions = {
        type: 'warning',
        title: t('退出确认'),
        message: t('仍有 {count} 个会话未结束，确定退出吗？', { count }),
        detail: t('退出将停止这些会话。'),
        buttons: [t('取消'), t('停止会话并退出')],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }
      const win = this.options.getWindow()
      const result = win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
      response = result.response
    } catch (error) {
      this.state = 'idle'
      console.error('[quit] Confirmation failed', error)
      return
    }
    if (response !== 1) {
      this.state = 'idle'
      return
    }
    this.state = 'approved'
    app.quit()
  }
}
