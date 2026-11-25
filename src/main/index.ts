import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session } from 'electron'
import path from 'node:path'
import { GROKBOT_FILE_SCHEME } from '@shared/grokbot'
import { setLanguage } from '@shared/i18n'
import { getTaskCounts } from '@shared/task-counts'
import { SKIN_SCHEME } from '@shared/skins'
import { skinsFor } from './skins'
import type { AgentEvent, AppState, CliProvider, ModelInfo, Settings } from '@shared/types'
import { grokBotFileResponse } from './grokbot-files'
import { acquireDesktopStartupLock, HEADLESS_LOCK_FILE, type AcquiredHeadlessLock } from './headless-lock'
import { createIpcHandlers } from './ipc'
import { configureManagedCliDirectory } from './managed-cli-location'
import { isTrustedAppFrame } from './ipc/guard'
import { flushGrokBotCaches, grokBotFiles } from './ipc/grokbot'
import { handlersForLocalCli, LocalControlServer } from './local-control'
import { notifyRunFinished } from './notify'
import { publish } from './publish'
import { QuitConfirmation } from './quit-confirmation'
import { RemoteRuntime } from './remote-runtime'
import { getRuntimeDataDir } from './runtime-paths'
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
let startupLock: AcquiredHeadlessLock | undefined
const modelsCache = new Map<CliProvider, ModelInfo[]>()
const remoteRuntime = new RemoteRuntime(
  () => store,
  () => snapshot()
)
const localControl = new LocalControlServer()

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
    starting: sessions.starting(),
    waitingForInput: sessions.waitingForInput(),
    queued: sessions.queued()
  }
}

function send(channel: string, payload: unknown): void {
  publish(win, remoteRuntime.server, channel, payload, localControl)
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

function ensureMainWindow(): BrowserWindow {
  if (!win || win.isDestroyed()) {
    win = createMainWindow()
    quitConfirmation.watchWindow(win)
    // Windows shutdown, restart and logoff end the process without emitting before-quit.
    win.on('session-end', cleanupBeforeExit)
    win.once('closed', () => { win = null })
    taskbarBadge?.sync(getTaskCounts(snapshot()).unread)
  }
  return win
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

function cleanupBeforeExit(): void {
  taskbarBadge?.restore()
  sessions?.stopAll()
  void remoteRuntime.stop()
  void localControl.stop()
  store?.flush()
  flushGrokBotCaches()
  startupLock?.release()
  startupLock = undefined
}

const quitConfirmation = new QuitConfirmation({
  getActiveCount: () => sessions?.active().length ?? 0,
  getWindow: () => win,
  onQuit: cleanupBeforeExit
})

app.whenReady().then(async () => {
  const dataDir = getRuntimeDataDir()
  let lockResult = await acquireDesktopStartupLock(dataDir)
  while (!lockResult.ok) {
    const holder = lockResult.holder
    const detail = holder.command ? `PID ${holder.pid} (${holder.command})` : `PID ${holder.pid}`
    console.error(`[headless-lock] Cannot start Agent Desktop while headless CLI is active (${detail})`)
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Agent Desktop',
      message: 'A headless Agent Desktop CLI process is currently using this data directory.',
      detail: `Process ${detail} holds ${HEADLESS_LOCK_FILE}. Wait for it to finish, then click Retry, or click Quit to avoid overwriting saved state.`,
      buttons: ['Retry', 'Quit'],
      defaultId: 0,
      cancelId: 1
    })
    if (response !== 0) {
      app.quit()
      return
    }
    lockResult = await acquireDesktopStartupLock(dataDir, { waitMs: 500 })
  }
  startupLock = lockResult.lock
  try {
    store = new Store()
    configureManagedCliDirectory(store.dataDir)
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
      notifyRunFinished(info, { enabled: store.settings.notifyOnComplete, getWindow: ensureMainWindow, send })
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
    void localControl.start({
      dataDir: store.dataDir,
      appVersion: app.getVersion(),
      handlers: handlersForLocalCli(handlers, snapshot)
    }).then(() => {
      // cli-control.json is now live (owned by this or another desktop window) and guards against headless CLI.
      startupLock?.release()
      startupLock = undefined
    }).catch((err) => {
      console.error('[cli-control] failed to start local control server', err)
    })
    ensureMainWindow()
    app.on('activate', () => {
      const current = ensureMainWindow()
      if (current.isMinimized()) current.restore()
      current.show()
      current.focus()
    })
  } catch (err) {
    startupLock?.release()
    startupLock = undefined
    throw err
  }
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('will-quit', () => {
  void localControl.stop()
  startupLock?.release()
  startupLock = undefined
  cleanupAcpUsagePreload()
  removeDir(sessionDataDir)
})
