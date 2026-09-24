import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, shell } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentEvent, AgentMode, AppState, Item, ModelInfo, Project, SendRequest, Settings, ThreadMeta } from '@shared/types'
import { parseModels, resolveCli, runCliOnce } from './cli'
import { loadCursorModelCatalog } from './model-catalog'
import { mergeModelLists } from '@shared/model-catalog'
import { gitDiff } from './git'
import { cliChatUpdatedAt, readCliTranscript, scanCliSessions, UNTITLED } from './history'
import { DEFAULT_TITLE, SessionManager, titleFrom, type RunFinished } from './sessions'
import { newId } from './id'
import { Store } from './store'

let win: BrowserWindow | null = null
let store: Store
let sessions: SessionManager
let modelsCache: ModelInfo[] | null = null

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
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const broadcastState = (): void => send('state:changed', snapshot())
const emitAgent = (ev: AgentEvent): void => send('agent:event', ev)

function notifyRunFinished(info: RunFinished): void {
  if (info.stopped || !store.settings.notifyOnComplete || !Notification.isSupported()) return
  const body = (info.failed ? (info.preview ? `未能完成：${info.preview}` : '任务未能完成') : info.preview || '任务已完成').slice(0, 180)
  const notification = new Notification({ title: info.title || 'Agent Desktop', body })
  notification.on('click', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    send('thread:focus', info.threadId)
  })
  notification.show()
}

function overlayColors(): { color: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#00000000', symbolColor: '#c9c9c9' }
    : { color: '#00000000', symbolColor: '#3a3a3a' }
}

function applyTheme(theme: Settings['theme']): void {
  nativeTheme.themeSource = theme
  if (isWin && win) win.setTitleBarOverlay({ ...overlayColors(), height: 44 })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#ffffff',
    titleBarStyle: 'hidden',
    ...(isWin ? { titleBarOverlay: { ...overlayColors(), height: 44 } } : {}),
    ...(isMac ? { trafficLightPosition: { x: 16, y: 15 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })
  if (!isMac) win.setMenu(null)

  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools()
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function openInEditor(target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('cursor', [isWin ? `"${target}"` : target], {
      shell: isWin,
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

function previewOf(items: Item[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'assistant') return it.text.replace(/\s+/g, ' ').trim().slice(0, 120)
  }
  return undefined
}

/** Replaces a thread's local items with the transcript stored by the CLI. */
function syncFromCli(threadId: string): Item[] | undefined {
  const t = store.thread(threadId)
  if (!t?.chatId || sessions.isRunning(threadId)) return undefined
  const items = readCliTranscript(t.chatId)
  if (!items) return undefined
  store.setItems(threadId, items)
  const firstUser = items.find((i) => i.kind === 'user')
  store.updateThread(threadId, {
    syncedAt: Date.now(),
    preview: previewOf(items) ?? t.preview,
    ...(t.title === UNTITLED && firstUser?.kind === 'user' ? { title: titleFrom(firstUser.text) } : {})
  })
  return items
}

function registerIpc(): void {
  ipcMain.handle('state:get', () => snapshot())

  ipcMain.handle('project:pick', async () => {
    const res = await dialog.showOpenDialog(win!, { title: '选择项目文件夹', properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths[0]) return null
    const p = store.addProject(res.filePaths[0])
    broadcastState()
    return p
  })
  ipcMain.handle('project:add', (_e, dir: string) => {
    if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`)
    const p = store.addProject(dir)
    broadcastState()
    return p
  })
  ipcMain.handle('project:update', (_e, id: string, patch: Partial<Project>) => {
    store.updateProject(id, patch)
    broadcastState()
  })
  ipcMain.handle('project:remove', (_e, id: string) => {
    for (const t of store.threads.filter((t) => t.projectId === id)) sessions.stop(t.id)
    store.removeProject(id)
    broadcastState()
  })
  ipcMain.handle('project:reorder', (_e, ids: string[]) => {
    store.reorderProjects(ids)
    broadcastState()
  })

  ipcMain.handle('thread:create', (_e, projectId: string, mode: AgentMode, model: string) => {
    if (!store.project(projectId)) throw new Error('项目不存在')
    const t = store.createThread({ projectId, title: DEFAULT_TITLE, mode, model, source: 'app' })
    broadcastState()
    return t
  })
  ipcMain.handle('thread:update', (_e, id: string, patch: Partial<ThreadMeta>) => {
    store.updateThread(id, patch)
    broadcastState()
  })
  ipcMain.handle('thread:delete', (_e, id: string) => {
    sessions.stop(id)
    store.deleteThread(id)
    broadcastState()
  })
  ipcMain.handle('thread:items', (_e, id: string) => {
    const t = store.thread(id)
    if (t?.source === 'cli' && t.chatId && !sessions.isRunning(id)) {
      const cliUpdated = cliChatUpdatedAt(t.chatId)
      if (cliUpdated && cliUpdated > (t.syncedAt ?? 0)) {
        try {
          if (syncFromCli(id)) broadcastState()
        } catch (err) {
          console.error('[history] sync failed', err)
        }
      }
    }
    return store.items(id)
  })
  ipcMain.handle('thread:syncFromCli', (_e, id: string) => {
    if (sessions.isRunning(id)) throw new Error('对话正在运行，请稍后再同步')
    const items = syncFromCli(id)
    if (!items) throw new Error('未在 ~/.cursor/chats 中找到该会话')
    broadcastState()
    return items
  })

  ipcMain.handle('agent:send', (_e, req: SendRequest) => sessions.send(req))
  ipcMain.handle('agent:stop', (_e, id: string) => sessions.stop(id))

  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => {
    const s = store.updateSettings(patch)
    if (patch.theme) applyTheme(patch.theme)
    if (patch.agentPath !== undefined) modelsCache = null
    broadcastState()
    return s
  })

  ipcMain.handle('cli:models', async (_e, refresh?: boolean) => {
    if (modelsCache && !refresh) return modelsCache
    const cli = resolveCli(store.settings.agentPath)
    if (!cli) return [{ id: 'auto', label: 'Auto' }]
    const res = await runCliOnce(cli, ['models'])
    const models = mergeModelLists(parseModels(res.stdout), loadCursorModelCatalog())
    if (models.length) modelsCache = models
    return models.length ? models : [{ id: 'auto', label: 'Auto' }]
  })

  ipcMain.handle('cli:info', async () => {
    const cli = resolveCli(store.settings.agentPath)
    if (!cli) return { found: false }
    const [version, status] = await Promise.all([runCliOnce(cli, ['--version']), runCliOnce(cli, ['status'])])
    return {
      found: true,
      path: cli.display,
      version: version.stdout.trim() || version.stderr.trim(),
      status: (status.stdout + status.stderr).trim()
    }
  })

  ipcMain.handle('cli:login', async () => {
    const cli = resolveCli(store.settings.agentPath)
    if (!cli) throw new Error('未找到 Cursor CLI')
    const res = await runCliOnce(cli, ['login'], 5 * 60_000)
    return (res.stdout + res.stderr).trim()
  })

  ipcMain.handle('cli:scan', () => {
    const imported = new Set(store.threads.map((t) => t.chatId).filter((x): x is string => !!x))
    return scanCliSessions(imported)
  })

  ipcMain.handle('cli:import', (_e, chatIds: string[]) => {
    const wanted = new Set(chatIds)
    const imported = new Set(store.threads.map((t) => t.chatId).filter(Boolean))
    let count = 0
    for (const s of scanCliSessions(new Set())) {
      if (!wanted.has(s.chatId) || imported.has(s.chatId)) continue
      const project = store.projectByPath(s.cwd) ?? store.addProject(s.cwd)
      const thread = store.createThread({
        projectId: project.id,
        title: s.title,
        chatId: s.chatId,
        cwd: s.cwd,
        mode: 'agent',
        source: 'cli',
        createdAt: s.createdAt || Date.now(),
        updatedAt: s.updatedAt || Date.now()
      })
      let synced = false
      try {
        synced = !!syncFromCli(thread.id)
      } catch (err) {
        console.error('[history] import transcript failed', s.chatId, err)
      }
      if (!synced) {
        store.items(thread.id).push({
          id: newId(),
          kind: 'notice',
          level: 'info',
          text: '未能读取此会话的历史消息，发送新消息仍会在原会话上下文中继续。'
        })
        store.markItemsDirty(thread.id)
      }
      count++
    }
    broadcastState()
    return count
  })

  ipcMain.handle('git:diff', (_e, cwd: string) => gitDiff(cwd))
  ipcMain.handle('shell:openPath', async (_e, p: string) => {
    await shell.openPath(p)
  })
  ipcMain.handle('shell:openInEditor', async (_e, p: string) => {
    const ok = await openInEditor(p)
    if (!ok) await shell.openPath(p)
    return ok
  })
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:/.test(url)) return shell.openExternal(url)
  })
}

if (process.env.AGENT_DESKTOP_USER_DATA) app.setPath('userData', process.env.AGENT_DESKTOP_USER_DATA)
if (isWin) app.setAppUserModelId(app.isPackaged ? 'dev.agentdesktop.app' : process.execPath)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    store = new Store()
    sessions = new SessionManager(store, emitAgent, broadcastState, notifyRunFinished)
    nativeTheme.themeSource = store.settings.theme
    nativeTheme.on('updated', () => {
      if (isWin && win) win.setTitleBarOverlay({ ...overlayColors(), height: 44 })
    })
    if (isMac) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    sessions?.stopAll()
    store?.flush()
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })
}
