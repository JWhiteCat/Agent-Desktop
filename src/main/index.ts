import { app, BrowserWindow, ipcMain, Menu, nativeTheme, protocol, session } from 'electron'
import path from 'node:path'
import { GROKBOT_FILE_SCHEME } from '@shared/grokbot'
import { setLanguage } from '@shared/i18n'
import { getTaskCounts } from '@shared/task-counts'
import { SKIN_SCHEME } from '@shared/skins'
import { skinsFor } from './skins'
import type { AgentEvent, AppState, CliProvider, ModelInfo, Settings } from '@shared/types'
import { grokBotFileResponse } from './grokbot-files'
import { createIpcHandlers } from './ipc'
import { isTrustedAppFrame } from './ipc/guard'
import { flushGrokBotCaches, grokBotFiles } from './ipc/grokbot'
import { notifyRunFinished } from './notify'
import { publish } from './publish'
import { QuitConfirmation } from './quit-confirmation'
import { RemoteRuntime } from './remote-runtime'
import { SessionManager } from './sessions'
import { cleanupAcpUsagePreload } from './acp-usage'
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
    running: sessions.running(),
    waitingForInput: sessions.waitingForInput()
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
// Cached Grok Bot files, by SHA-256. Only hashes seen in a transcript are served; see grokbot-files.ts.
protocol.registerSchemesAsPrivileged([
  { scheme: GROKBOT_FILE_SCHEME, privileges: { standard: true, secure: true } },
  { scheme: SKIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
])

const quitConfirmation = new QuitConfirmation({
  getActiveCount: () => sessions?.active().length ?? 0,
  getWindow: () => win,
  onQuit: () => {
    taskbarBadge?.restore()
    sessions?.stopAll()
    void remoteRuntime.stop()
    store?.flush()
    flushGrokBotCaches()
  }
})

app.whenReady().then(() => {
  store = new Store()
  setLanguage(store.settings.language, app.getLocale())
  protocol.handle(GROKBOT_FILE_SCHEME, (request) => grokBotFileResponse(grokBotFiles, request.url))
  protocol.handle(SKIN_SCHEME, (request) => skinsFor(store).response(request))
  session.defaultSession.setPermissionCheckHandler((contents, _permission, _origin, details) => contents === win?.webContents && details.isMainFrame)
  session.defaultSession.setPermissionRequestHandler((contents, _permission, callback, details) => callback(contents === win?.webContents && details.isMainFrame))
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const origin = [details.frame?.url, details.initiatorOrigin, details.referrer].find(url => url?.startsWith(`${SKIN_SCHEME}:`))
    if (origin) {
      try {
        const target = new URL(details.url)
        callback({ cancel: target.protocol !== `${SKIN_SCHEME}:` || target.host !== new URL(origin).host })
      } catch { callback({ cancel: true }) }
    } else callback({})
  })
  try {
    syncAllManagedSkills(store.settings.skills)
  } catch (err) {
    console.error('[skills] sync failed', err)
  }
  sessions = new SessionManager(store, emitAgent, broadcastState, (info) =>
    notifyRunFinished(info, { enabled: store.settings.notifyOnComplete, getWindow: () => win, send })
  )
  taskbarBadge = new UnreadTaskbarBadge({
    getWindow: () => win
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
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(name, (e, ...args) => {
    if (!isTrustedAppFrame(e, win)) throw new Error('Untrusted IPC sender')
    return fn(...args)
  })
  void remoteRuntime.apply()
  win = createMainWindow()
  quitConfirmation.watchWindow(win)
  taskbarBadge.sync(getTaskCounts(snapshot()).unread)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createMainWindow()
      quitConfirmation.watchWindow(win)
      taskbarBadge?.sync(getTaskCounts(snapshot()).unread)
    }
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('will-quit', () => {
  cleanupAcpUsagePreload()
  removeDir(sessionDataDir)
})
