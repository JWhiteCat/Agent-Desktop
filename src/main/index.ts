import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from 'electron'
import path from 'node:path'
import { setLanguage } from '@shared/i18n'
import { getTaskCounts } from '@shared/task-counts'
import type { AgentEvent, AppState, CliProvider, ModelInfo, Settings } from '@shared/types'
import { createIpcHandlers } from './ipc'
import { notifyRunFinished } from './notify'
import { publish } from './publish'
import { RemoteRuntime } from './remote-runtime'
import { SessionManager } from './sessions'
import { syncAllManagedSkills } from './skills'
import { Store } from './store'
import { UnreadTaskbarBadge } from './taskbar-badge'
import { applyWindowTheme, createMainWindow, installSessionData, removeDir, syncTitleBar } from './window'

let win: BrowserWindow | null = null
let store: Store
let sessions: SessionManager
let taskbarBadge: UnreadTaskbarBadge | undefined
const modelsCache = new Map<CliProvider, ModelInfo[]>()
const remoteRuntime = new RemoteRuntime(
  () => store,
  () => snapshot()
)

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const windowsAppId = app.isPackaged ? 'dev.agentdesktop.app' : process.execPath

function snapshot(): AppState {
  return {
    systemLocale: app.getLocale(),
    projects: store.projects,
    threads: store.threads,
    settings: store.settings,
    running: sessions.running()
  }
}

function send(channel: string, payload: unknown): void {
  publish(win, remoteRuntime.server, channel, payload)
}

const broadcastState = (): void => {
  const state = snapshot()
  taskbarBadge?.sync(getTaskCounts(state).unread)
  send('state:changed', state)
}
const emitAgent = (ev: AgentEvent): void => send('agent:event', ev)

function applyTheme(theme: Settings['theme']): void {
  applyWindowTheme(win, theme)
}

if (process.env.AGENT_DESKTOP_USER_DATA) app.setPath('userData', process.env.AGENT_DESKTOP_USER_DATA)
// Chromium locks GPUCache under sessionData. A second window sharing that directory fails with
// "Unable to move the cache" / "Gpu Cache Creation failed". App data stays in userData.
const sessionDataDir = installSessionData()
if (isWin) app.setAppUserModelId(windowsAppId)

app.whenReady().then(() => {
  store = new Store()
  setLanguage(store.settings.language, app.getLocale())
  try {
    syncAllManagedSkills(store.settings.skills)
  } catch (err) {
    console.error('[skills] sync failed', err)
  }
  sessions = new SessionManager(store, emitAgent, broadcastState, (info) =>
    notifyRunFinished(info, { enabled: store.settings.notifyOnComplete, getWindow: () => win, send })
  )
  taskbarBadge = new UnreadTaskbarBadge({
    getWindow: () => win,
    appId: windowsAppId,
    iconPath: process.execPath,
    cacheDir: path.join(app.getPath('userData'), 'taskbar-icons')
  })
  nativeTheme.themeSource = store.settings.theme
  nativeTheme.on('updated', () => syncTitleBar(win))
  if (isMac) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
  const handlers = createIpcHandlers({
    store,
    sessions,
    modelsCache,
    snapshot,
    broadcast: broadcastState,
    getWindow: () => win,
    applyTheme,
    applyRemote: () => remoteRuntime.apply(),
    remoteInfo: () => remoteRuntime.info()
  })
  remoteRuntime.bind(handlers)
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(name, (_e, ...args) => fn(...args))
  void remoteRuntime.apply()
  win = createMainWindow()
  if (isWin) win.once('close', () => taskbarBadge?.restore())
  taskbarBadge.sync(getTaskCounts(snapshot()).unread)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createMainWindow()
      if (isWin) win.once('close', () => taskbarBadge?.restore())
      taskbarBadge?.sync(getTaskCounts(snapshot()).unread)
    }
  })
})

app.on('before-quit', () => {
  taskbarBadge?.restore()
  sessions?.stopAll()
  void remoteRuntime.stop()
  store?.flush()
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('will-quit', () => {
  removeDir(sessionDataDir)
})
