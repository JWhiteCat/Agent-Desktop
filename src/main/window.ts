import { app, BrowserWindow, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { t } from '@shared/i18n'
import type { Settings } from '@shared/types'
import { cliEnvironment } from './cli-runtime'

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

function overlayColors(): { color: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#00000000', symbolColor: '#c9c9c9' }
    : { color: '#00000000', symbolColor: '#3a3a3a' }
}

export function syncTitleBar(win: BrowserWindow | null): void {
  if (isWin && win) win.setTitleBarOverlay({ ...overlayColors(), height: 44 })
}

export function applyWindowTheme(win: BrowserWindow | null, theme: Settings['theme']): void {
  nativeTheme.themeSource = theme
  syncTitleBar(win)
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#ffffff',
    ...(process.platform === 'linux' ? { icon: path.join(app.getAppPath(), 'resources/icons/512x512.png') } : {}),
    // Linux uses the window manager's native frame and controls (including Wayland).
    // `hidden` without an overlay removes close/minimize/maximize on Linux.
    ...((isWin || isMac) ? { titleBarStyle: 'hidden' as const } : {}),
    ...(isWin ? { titleBarOverlay: { ...overlayColors(), height: 44 } } : {}),
    ...(isMac ? { trafficLightPosition: { x: 16, y: 15 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  if (!isMac) win.setMenu(null)

  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
  })
  win.webContents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable || params.selectionText.length > 0) {
      items.push({ label: t('复制'), enabled: params.editFlags.canCopy, click: () => win.webContents.copy() })
    }
    if (params.isEditable) {
      // Native paste retains the caret and dispatches the composer's image paste event.
      items.push({ label: t('粘贴'), enabled: params.editFlags.canPaste, click: () => win.webContents.paste() })
    }
    if (!items.length) return
    Menu.buildFromTemplate(items).popup({ window: win, x: params.x, y: params.y, sourceType: params.menuSourceType })
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
  return win
}

export function openInEditor(target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('cursor', [isWin ? `"${target}"` : target], {
      shell: isWin,
      env: cliEnvironment(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}

/** Gives this process its own Chromium profile (GPU cache, HTTP cache, localStorage). */
export function installSessionData(): string {
  // A shared /tmp root is owned by whichever desktop user launches first, and can
  // prevent other users from starting. Keep Chromium caches private to this profile.
  const root = path.join(app.getPath('userData'), 'session-cache')
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const name of fs.readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid === process.pid || isProcessAlive(pid)) continue
    removeDir(path.join(root, name))
  }
  const dir = path.join(root, String(process.pid))
  removeDir(dir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  app.setPath('sessionData', dir)
  return dir
}

export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Cache files can stay locked until the process has fully exited.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
