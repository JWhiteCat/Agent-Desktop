import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from 'electron'
import type { AgentEvent, AppState, CliProvider, ModelInfo, Settings } from '@shared/types'
import { createIpcHandlers } from './ipc'
import { notifyRunFinished } from './notify'
import { publish } from './publish'
import { RemoteRuntime } from './remote-runtime'
import { SessionManager } from './sessions'
import { syncAllManagedSkills } from './skills'
import { Store } from './store'
import { applyWindowTheme, createMainWindow, installSessionData, removeDir, syncTitleBar } from './window'

let win: BrowserWindow | null = null
let store: Store
let sessions: SessionManager
const modelsCache = new Map<CliProvider, ModelInfo[]>()
const remoteRuntime = new RemoteRuntime(
  () => store,
  () => snapshot()
)

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

function snapshot(): AppState {
  return {
    projects: store.projects,
    threads: store.threads,
    settings: store.settings,
    running: sessions.running()
  }
}

function send(channel: string, payload: unknown): void {
  publish(win, remoteRuntime.server, channel, payload)
}

const broadcastState = (): void => send('state:changed', snapshot())
const emitAgent = (ev: AgentEvent): void => send('agent:event', ev)

function applyTheme(theme: Settings['theme']): void {
  applyWindowTheme(win, theme)
}

if (process.env.AGENT_DESKTOP_USER_DATA) app.setPath('userData', process.env.AGENT_DESKTOP_USER_DATA)
// Chromium locks GPUCache under sessionData. A second window sharing that directory fails with
// "Unable to move the cache" / "Gpu Cache Creation failed". App data stays in userData.
const sessionDataDir = installSessionData()
if (isWin) app.setAppUserModelId(app.isPackaged ? 'dev.agentdesktop.app' : process.execPath)

app.whenReady().then(() => {
  store = new Store()
  try {
    syncAllManagedSkills(store.settings.skills)
  } catch (err) {
    console.error('[skills] sync failed', err)
  }
  sessions = new SessionManager(store, emitAgent, broadcastState, (info) =>
    notifyRunFinished(info, { enabled: store.settings.notifyOnComplete, getWindow: () => win, send })
  )
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createMainWindow()
  })
})

app.on('before-quit', () => {
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
