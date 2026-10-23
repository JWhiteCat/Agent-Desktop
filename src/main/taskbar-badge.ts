import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { t } from '@shared/i18n'
import { createUnreadBadgeBitmap, unreadBadgeLabel } from './taskbar-icon'

interface Options {
  getWindow(): BrowserWindow | null
}

/** The main process owns the count, even while the renderer is minimized or disconnected. */
export class UnreadTaskbarBadge {
  private stopped = false
  private count = 0
  private window?: BrowserWindow
  private appliedLabel?: string
  private refreshTimer?: ReturnType<typeof setInterval>
  private readonly icons = new Map<string, NativeImage>()
  private readonly refresh = (): void => this.apply(true)
  private readonly closed = (): void => this.detachWindow()

  constructor(private readonly options: Options) {}

  sync(count: number): void {
    if (this.stopped) return
    if (process.platform === 'darwin') {
      const label = unreadBadgeLabel(count)
      if (label === this.appliedLabel) return
      try {
        app.dock?.setBadge(label)
        this.appliedLabel = label
      } catch (error) {
        console.error('[dock] Badge update failed', error)
      }
      return
    }
    if (process.platform !== 'win32') return
    this.count = count
    this.apply()
  }

  restore(): void {
    this.sync(0)
    this.stopped = true
    this.detachWindow()
  }

  private detachWindow(): void {
    this.window?.removeListener('show', this.refresh)
    this.window?.removeListener('restore', this.refresh)
    this.window?.removeListener('closed', this.closed)
    this.window = undefined
    this.appliedLabel = undefined
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = undefined
  }

  private apply(force = false): void {
    if (this.stopped) return
    const win = this.options.getWindow()
    if (!win || win.isDestroyed()) {
      this.detachWindow()
      return
    }
    if (win !== this.window) {
      this.detachWindow()
      this.window = win
      win.on('show', this.refresh)
      win.on('restore', this.refresh)
      win.once('closed', this.closed)
    }
    const label = unreadBadgeLabel(this.count)
    if (!label && this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = undefined
    } else if (label && !this.refreshTimer) {
      // Explorer can silently discard an update before TaskbarButtonCreated, and
      // Electron does not replay overlays after Explorer restarts. Reassert while
      // unread, including when minimized, without depending on renderer activity.
      this.refreshTimer = setInterval(this.refresh, 5_000)
      this.refreshTimer.unref()
    }
    if (!force && label === this.appliedLabel) return
    try {
      let icon: NativeImage | null = null
      if (label) {
        icon = this.icons.get(label) ?? nativeImage.createFromBitmap(createUnreadBadgeBitmap(32, label), {
          width: 32, height: 32, scaleFactor: 1
        })
        if (icon.isEmpty()) throw new Error('Could not create the taskbar overlay')
        this.icons.set(label, icon)
      }
      // A native overlay applies to pinned/grouped buttons too. setIcon only
      // changes the window icon; setAppDetails supplies shortcut relaunch metadata.
      win.setOverlayIcon(icon, label ? `${label} ${t('未读')}` : '')
      this.appliedLabel = label
    } catch (error) {
      // Shell errors must not interrupt task execution or state broadcasts.
      console.error('[taskbar] Overlay update failed', error)
    }
  }
}
