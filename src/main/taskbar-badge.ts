import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { paintUnreadBadge, pngsToIco, unreadBadgeLabel } from './taskbar-icon'

interface Options {
  getWindow(): BrowserWindow | null
  appId: string
  iconPath: string
  cacheDir: string
}

/** The main process owns the count, even while the renderer is minimized or disconnected. */
export class UnreadTaskbarBadge {
  private base?: NativeImage
  private loading?: Promise<void>
  private failed = false
  private stopped = false
  private count = 0
  private appliedWindow?: BrowserWindow
  private appliedLabel?: string
  private readonly icons = new Map<string, { image: NativeImage; file: string }>()

  constructor(private readonly options: Options) {}

  sync(count: number): void {
    if (process.platform !== 'win32' || this.failed || this.stopped) return
    this.count = count
    if (this.base) this.apply()
    else if (!this.loading) {
      this.loading = app.getFileIcon(this.options.iconPath, { size: 'normal' }).then((icon) => {
        if (icon.isEmpty()) throw new Error('The executable has no readable icon')
        this.base = icon
        this.apply()
      }).catch((error) => {
        this.failed = true
        console.error('[taskbar] Icon initialization failed', error)
      })
    }
  }

  /** Do not leave the running window's relaunch properties pointing at an unread icon on quit. */
  restore(): void {
    this.sync(0)
    this.stopped = true
  }

  private apply(): void {
    const win = this.options.getWindow()
    if (!this.base || !win || win.isDestroyed()) return
    const label = unreadBadgeLabel(this.count)
    if (win === this.appliedWindow && label === this.appliedLabel) return
    try {
      let icon = this.icons.get(label)
      if (!icon) {
        if (!label) icon = { image: this.base, file: this.options.iconPath }
        else {
          // Shell icons can carry the display's scale factor. Flatten to 1x so bitmap
          // dimensions agree with createFromBitmap at 125%, 150%, and 200% scaling.
          const bitmapBase = nativeImage.createFromBuffer(this.base.toPNG({ scaleFactor: 1 }), { scaleFactor: 1 })
          const images = [16, 32, 48, 64].map((size) => {
            const base = bitmapBase.resize({ width: size, height: size, quality: 'best' })
            const image = nativeImage.createFromBitmap(paintUnreadBadge(base.toBitmap({ scaleFactor: 1 }), size, label), { width: size, height: size, scaleFactor: 1 })
            return { size, png: image.toPNG() }
          })
          fs.mkdirSync(this.options.cacheDir, { recursive: true })
          const file = path.join(this.options.cacheDir, `unread-${label.replace('+', 'plus')}.ico`)
          fs.writeFileSync(file, pngsToIco(images))
          icon = { image: nativeImage.createFromPath(file), file }
          if (icon.image.isEmpty()) throw new Error('Could not load the generated taskbar icon')
        }
        this.icons.set(label, icon)
      }
      win.setIcon(icon.image)
      win.setAppDetails({ appId: this.options.appId, appIconPath: icon.file, appIconIndex: 0 })
      this.appliedWindow = win
      this.appliedLabel = label
    } catch (error) {
      // A shell or cache error must not interrupt task execution or state broadcasts.
      console.error('[taskbar] Icon update failed', error)
    }
  }
}
