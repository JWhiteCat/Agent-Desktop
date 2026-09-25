import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, shell } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentEvent, AgentMode, AppState, CliProvider, Item, ModelInfo, Project, QuestionAnswer, RemoteInfo, SendRequest, Settings, ThreadMeta } from '@shared/types'
import { threadCli } from '@shared/types'
import { parseModels, resolveApiKey, resolveCli, runCliOnce } from './cli'
import { loadCursorModelCatalog } from './model-catalog'
import { mergeModelLists } from '@shared/model-catalog'
import { gitDiff } from './git'
import { materializeCliFork, planCliFork } from './fork'
import { cliChatUpdatedAt, findChatDir, readCliTranscript, scanCliSessions, UNTITLED } from './history'
import { codexChatUpdatedAt, readCodexTranscript, scanCodexSessions } from './codex-history'
import { codexLogin, codexStatus, codexVersion, listCodexModels, resolveCodex, resolveCodexApiKey } from './codex'
import { DEFAULT_TITLE, SessionManager, titleFrom, type RunFinished } from './sessions'
import { newId } from './id'
import { syncAllManagedSkills, userSkillsDir } from './skills'
import { normalizeMcpServers, normalizeSkills } from '@shared/agent-config'
import { Store } from './store'
import { lanAddresses, newRemoteToken, RemoteServer, type Handler } from './remote'
import { PublicTunnel, publicRemoteUrl, validatePublicHost, validatePublicPort, validatePublicUser } from './public-tunnel'
import { listSessionUsage, summarizeUsage, type UsageWindow } from '@shared/usage'

let win: BrowserWindow | null = null
let store: Store
let sessions: SessionManager
const modelsCache = new Map<CliProvider, ModelInfo[]>()
const remote = new RemoteServer()
const publicTunnel = new PublicTunnel()
let remoteError: string | undefined
let publicError: string | undefined

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

/** Hides secrets from remote clients. */
function remoteSafeSettings(s: Settings): Settings {
  return { ...s, apiKey: '', codexApiKey: '', remoteToken: '' }
}

function remoteSafeState(state: AppState): AppState {
  return { ...state, settings: remoteSafeSettings(state.settings) }
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  if (channel === 'state:changed') remote.broadcast(channel, remoteSafeState(payload as AppState))
  else if (channel === 'agent:event') remote.broadcast(channel, payload)
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

const FORK_NOTICE = '未能复制 Cursor CLI 的会话上下文，之后发送的消息会从新会话开始。'
const CODEX_FORK_NOTICE = '已复制对话记录。之后发送的消息会从新的 Codex 会话开始。'

function forkTitle(title: string, projectId: string): string {
  const base = title.replace(/^\(\d+\)\s+/, '')
  const taken = new Set(store.threads.filter((t) => t.projectId === projectId).map((t) => t.title))
  let n = 1
  while (taken.has(`(${n}) ${base}`)) n++
  return `(${n}) ${base}`
}

function cloneItems(items: Item[]): Item[] {
  const cloned = structuredClone(items) as Item[]
  for (const it of cloned) {
    // Keep usageId so a forked turn is not counted again.
    it.id = newId()
    if (it.kind === 'question' && it.status === 'pending') it.status = 'skipped'
    if (it.kind === 'tool' && it.status === 'running') it.status = 'error'
    if (it.kind === 'thinking' && !it.done) it.done = true
  }
  return cloned
}

/** Copies a conversation into a new thread. `throughItemId` keeps history only up to that message. */
function forkThread(id: string, throughItemId?: string): { thread: ThreadMeta; items: Item[] } {
  if (sessions.isRunning(id)) throw new Error('对话正在运行，请稍后再分叉')
  const src = store.thread(id)
  if (!src) throw new Error('对话不存在')
  const items = store.items(id)
  const cut = throughItemId ? items.findIndex((it) => it.id === throughItemId) : items.length - 1
  if (cut < 0) throw new Error('找不到要分叉的消息')
  const prefix = items.slice(0, cut + 1)
  if (!prefix.some((it) => it.kind === 'user' || it.kind === 'assistant')) throw new Error('没有可以分叉的内容')

  const cloned = cloneItems(prefix)
  const title = forkTitle(src.title, src.projectId)
  const cli = threadCli(src)
  let chatId: string | undefined
  let cwd = src.cwd
  if (cli === 'codex') {
    if (src.chatId) cloned.push({ id: newId(), kind: 'notice', level: 'info', text: CODEX_FORK_NOTICE })
  } else if (src.chatId) {
    const dir = findChatDir(src.chatId)
    const plan = dir ? planCliFork(dir, items, throughItemId) : { extraBlobs: [], linked: false }
    if (!dir || !plan.linked) {
      cloned.push({ id: newId(), kind: 'notice', level: 'info', text: FORK_NOTICE })
    } else {
      try {
        const made = materializeCliFork(dir, plan, title)
        chatId = made.chatId
        if (made.cwd) cwd = made.cwd
      } catch (err) {
        console.error('[fork] copy failed', err)
        cloned.push({ id: newId(), kind: 'notice', level: 'info', text: FORK_NOTICE })
      }
    }
  }

  const thread = store.createThread({
    projectId: src.projectId,
    title,
    chatId,
    cwd,
    cli,
    model: src.model,
    modelLabel: src.modelLabel,
    mode: src.mode,
    worktree: src.worktree,
    preview: previewOf(cloned),
    source: 'app',
    ...(chatId ? { syncedAt: Date.now() } : {})
  })
  store.setItems(thread.id, cloned)
  broadcastState()
  return { thread, items: cloned }
}

/** Replaces a thread's local items with the transcript stored by the CLI. */
function syncFromCli(threadId: string): Item[] | undefined {
  const t = store.thread(threadId)
  if (!t?.chatId || sessions.isRunning(threadId)) return undefined
  const items = threadCli(t) === 'codex' ? readCodexTranscript(t.chatId) : readCliTranscript(t.chatId)
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

const handlers: Record<string, Handler> = {
  'state:get': () => snapshot(),

  'project:pick': async () => {
    const res = await dialog.showOpenDialog(win!, { title: '选择项目文件夹', properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths[0]) return null
    const p = store.addProject(res.filePaths[0])
    broadcastState()
    return p
  },
  'project:add': (dir: string) => {
    if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`)
    const p = store.addProject(dir)
    broadcastState()
    return p
  },
  'project:update': (id: string, patch: Partial<Project>) => {
    store.updateProject(id, patch)
    broadcastState()
  },
  'project:remove': (id: string) => {
    for (const t of store.threads.filter((t) => t.projectId === id)) sessions.dispose(t.id)
    store.removeProject(id)
    broadcastState()
  },
  'project:reorder': (ids: string[]) => {
    store.reorderProjects(ids)
    broadcastState()
  },

  'thread:create': (projectId: string, mode: AgentMode, model: string) => {
    if (!store.project(projectId)) throw new Error('项目不存在')
    const t = store.createThread({ projectId, title: DEFAULT_TITLE, mode, model, cli: store.settings.cliProvider, source: 'app' })
    broadcastState()
    return t
  },
  'thread:update': (id: string, patch: Partial<ThreadMeta>) => {
    store.updateThread(id, patch)
    broadcastState()
  },
  'thread:delete': (id: string) => {
    sessions.dispose(id)
    store.deleteThread(id)
    broadcastState()
  },
  'thread:items': (id: string) => {
    const t = store.thread(id)
    if (t?.source === 'cli' && t.chatId && !sessions.isRunning(id)) {
      const cliUpdated = threadCli(t) === 'codex' ? codexChatUpdatedAt(t.chatId) : cliChatUpdatedAt(t.chatId)
      if (cliUpdated && cliUpdated > (t.syncedAt ?? 0)) {
        try {
          if (syncFromCli(id)) broadcastState()
        } catch (err) {
          console.error('[history] sync failed', err)
        }
      }
    }
    return store.items(id)
  },
  'thread:fork': (id: string, throughItemId?: string) => forkThread(id, throughItemId),
  'thread:syncFromCli': (id: string) => {
    if (sessions.isRunning(id)) throw new Error('对话正在运行，请稍后再同步')
    const items = syncFromCli(id)
    if (!items) throw new Error(threadCli(store.thread(id) ?? { cli: 'cursor' }) === 'codex' ? '未在 ~/.codex/sessions 中找到该会话' : '未在 ~/.cursor/chats 中找到该会话')
    broadcastState()
    return items
  },

  'agent:send': (req: SendRequest) => sessions.send(req),
  'agent:stop': (id: string) => sessions.stop(id),
  'agent:answerQuestion': (threadId: string, questionId: string, answers: QuestionAnswer[] | null) => {
    sessions.answerQuestion(threadId, questionId, answers)
  },

  'usage:summary': (period: UsageWindow) => {
    const threads = store.threads.map((t) => ({
      id: t.id,
      title: t.title,
      project: store.project(t.projectId)?.name,
      model: t.model,
      updatedAt: t.updatedAt,
      items: store.items(t.id)
    }))
    return { summary: summarizeUsage(threads, period), sessions: listSessionUsage(threads) }
  },

  'settings:update': async (patch: Partial<Settings>) => {
    const next: Partial<Settings> = { ...patch }
    if (patch.mcpServers !== undefined) next.mcpServers = normalizeMcpServers(patch.mcpServers)
    if (patch.remotePort !== undefined) {
      const port = Math.trunc(Number(patch.remotePort))
      if (!(port >= 1024 && port <= 65535)) throw new Error('端口需在 1024–65535 之间')
      next.remotePort = port
    }
    if (patch.remotePublicUser !== undefined) next.remotePublicUser = validatePublicUser(patch.remotePublicUser)
    if (patch.remotePublicHost !== undefined) next.remotePublicHost = validatePublicHost(patch.remotePublicHost)
    if (patch.remotePublicPort !== undefined) next.remotePublicPort = validatePublicPort(Number(patch.remotePublicPort))
    if (patch.skills !== undefined) {
      next.skills = normalizeSkills(patch.skills)
      syncAllManagedSkills(next.skills)
    }
    if (patch.cliProvider !== undefined && patch.cliProvider !== 'cursor' && patch.cliProvider !== 'codex') {
      next.cliProvider = 'cursor'
    }
    const s = store.updateSettings(next)
    if (patch.theme) applyTheme(patch.theme)
    if (patch.agentPath !== undefined || patch.apiKey !== undefined) modelsCache.delete('cursor')
    if (patch.codexPath !== undefined || patch.codexApiKey !== undefined) modelsCache.delete('codex')
    if (
      patch.agentPath !== undefined ||
      patch.apiKey !== undefined ||
      patch.codexPath !== undefined ||
      patch.codexApiKey !== undefined ||
      patch.sandbox !== undefined ||
      patch.mcpServers !== undefined ||
      patch.skills !== undefined
    ) {
      sessions.dropIdle()
    }
    if (
      patch.remoteEnabled !== undefined ||
      patch.remotePort !== undefined ||
      patch.remoteToken !== undefined ||
      patch.remotePublicEnabled !== undefined ||
      patch.remotePublicUser !== undefined ||
      patch.remotePublicHost !== undefined ||
      patch.remotePublicPort !== undefined
    ) {
      await applyRemote()
    }
    broadcastState()
    return s
  },

  'cli:models': async (refresh?: boolean, provider?: CliProvider) => {
    const cli = provider === 'codex' || provider === 'cursor' ? provider : store.settings.cliProvider
    const cached = modelsCache.get(cli)
    if (cached && !refresh) return cached
    const models = cli === 'codex' ? await codexModelList() : await cursorModelList()
    if (models.length) modelsCache.set(cli, models)
    return models
  },

  'cli:info': async (provider?: CliProvider) => {
    const cli = provider === 'codex' || provider === 'cursor' ? provider : store.settings.cliProvider
    if (cli === 'codex') return await codexInfo()
    const cursor = resolveCli(store.settings.agentPath)
    if (!cursor) return { found: false }
    const apiKey = resolveApiKey(store.settings.apiKey)
    const [version, status] = await Promise.all([
      runCliOnce(cursor, ['--version']),
      runCliOnce(cursor, ['status'], 60_000, apiKey || undefined)
    ])
    return {
      found: true,
      path: cursor.display,
      version: version.stdout.trim() || version.stderr.trim(),
      status: (status.stdout + status.stderr).trim(),
      hasApiKey: !!apiKey
    }
  },

  'cli:login': async (provider?: CliProvider) => {
    const cli = provider === 'codex' || provider === 'cursor' ? provider : store.settings.cliProvider
    if (cli === 'codex') {
      const codex = resolveCodex(store.settings.codexPath)
      if (!codex) throw new Error('未找到 Codex CLI')
      return codexLogin(codex)
    }
    const cursor = resolveCli(store.settings.agentPath)
    if (!cursor) throw new Error('未找到 Cursor CLI')
    const res = await runCliOnce(cursor, ['login'], 5 * 60_000, false)
    return (res.stdout + res.stderr).trim()
  },

  'cli:scan': () => {
    const imported = new Set(store.threads.map((t) => t.chatId).filter((x): x is string => !!x))
    return [...scanCliSessions(imported), ...scanCodexSessions(imported)].sort((a, b) => b.updatedAt - a.updatedAt)
  },

  'cli:import': (chatIds: string[]) => {
    const wanted = new Set(chatIds)
    const imported = new Set(store.threads.map((t) => t.chatId).filter(Boolean))
    let count = 0
    const found = [...scanCliSessions(new Set()), ...scanCodexSessions(new Set())]
    for (const s of found) {
      if (!wanted.has(s.chatId) || imported.has(s.chatId)) continue
      const project = store.projectByPath(s.cwd) ?? store.addProject(s.cwd)
      const thread = store.createThread({
        projectId: project.id,
        title: s.title,
        chatId: s.chatId,
        cwd: s.cwd,
        cli: s.cli,
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
  },

  'git:diff': (cwd: string) => gitDiff(cwd),
  'shell:openPath': async (p: string) => {
    await shell.openPath(p)
  },
  'shell:openSkills': async () => {
    const dir = userSkillsDir()
    fs.mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
  },
  'shell:openInEditor': async (p: string) => {
    const ok = await openInEditor(p)
    if (!ok) await shell.openPath(p)
    return ok
  },
  'shell:openExternal': (url: string) => {
    if (/^https?:/.test(url)) return shell.openExternal(url)
  },
  'remote:info': () => remoteInfo(),
  'remote:resetToken': async () => {
    store.updateSettings({ remoteToken: newRemoteToken() })
    await applyRemote()
    broadcastState()
    return remoteInfo()
  }
}

const REMOTE_BLOCKED = new Set(['project:pick', 'remote:info', 'remote:resetToken'])
const REMOTE_ONLY_DESKTOP_SETTINGS: (keyof Settings)[] = [
  'remoteEnabled',
  'remotePort',
  'remoteToken',
  'remotePublicEnabled',
  'remotePublicUser',
  'remotePublicHost',
  'remotePublicPort'
]

/** What a phone browser may call: no native dialogs, no remote-control settings, no secrets. */
function remoteHandlers(): Record<string, Handler> {
  const out: Record<string, Handler> = {}
  for (const [name, fn] of Object.entries(handlers)) if (!REMOTE_BLOCKED.has(name)) out[name] = fn
  out['state:get'] = () => remoteSafeState(snapshot())
  out['settings:update'] = async (patch: Partial<Settings>) => {
    const safe: Partial<Settings> = { ...patch }
    for (const key of REMOTE_ONLY_DESKTOP_SETTINGS) delete safe[key]
    if (!safe.apiKey) delete safe.apiKey
    if (!safe.codexApiKey) delete safe.codexApiKey
    return remoteSafeSettings((await handlers['settings:update'](safe)) as Settings)
  }
  return out
}

function registerIpc(): void {
  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(name, (_e, ...args) => fn(...args))
}

function remoteInfo(): RemoteInfo {
  const s = store.settings
  const port = remote.port ?? s.remotePort
  const publicOn = s.remoteEnabled && s.remotePublicEnabled
  const link = publicOn && publicTunnel.status === 'up' ? publicRemoteUrl(s.remotePublicHost, s.remotePublicPort, s.remoteToken) : undefined
  const tunnelError = publicOn ? publicError || publicTunnel.error : undefined
  return {
    enabled: s.remoteEnabled,
    running: remote.running,
    port,
    urls: [...(remote.running ? lanAddresses().map((ip) => `http://${ip}:${port}/?token=${s.remoteToken}`) : []), ...(link ? [link] : [])],
    ...(remoteError ? { error: remoteError } : {}),
    publicStatus: publicOn ? publicTunnel.status : 'off',
    ...(link ? { publicUrl: link } : {}),
    ...(tunnelError ? { publicError: tunnelError } : {})
  }
}

/** Starts, restarts or stops the LAN server to match the settings. */
async function applyRemote(): Promise<void> {
  remoteError = undefined
  const s = store.settings
  if (!s.remoteEnabled) {
    await remote.stop()
    await applyPublicTunnel()
    return
  }
  if (!s.remoteToken) store.updateSettings({ remoteToken: newRemoteToken() })
  try {
    await remote.start({
      port: s.remotePort,
      token: store.settings.remoteToken,
      handlers: remoteHandlers(),
      devUrl: process.env.ELECTRON_RENDERER_URL,
      staticDir: path.join(__dirname, '../renderer')
    })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    remoteError = code === 'EADDRINUSE' ? `端口 ${s.remotePort} 已被占用，请换一个端口` : err instanceof Error ? err.message : String(err)
    console.error('[remote] start failed', err)
  }
  await applyPublicTunnel()
}

/** Starts or stops the public SSH tunnel to match the settings. The LAN server must already be up. */
async function applyPublicTunnel(): Promise<void> {
  publicError = undefined
  const s = store.settings
  if (!s.remoteEnabled || !s.remotePublicEnabled || !remote.running) {
    await publicTunnel.stop()
    if (s.remoteEnabled && s.remotePublicEnabled && !remote.running) publicError = '局域网服务未启动，无法建立公网隧道'
    return
  }
  try {
    await publicTunnel.start({
      user: validatePublicUser(s.remotePublicUser),
      host: validatePublicHost(s.remotePublicHost),
      port: validatePublicPort(s.remotePublicPort),
      localPort: remote.port ?? s.remotePort
    })
  } catch (err) {
    await publicTunnel.stop()
    publicError = err instanceof Error ? err.message : String(err)
    console.error('[remote] public tunnel failed', err)
  }
}

async function cursorModelList(): Promise<ModelInfo[]> {
  const cli = resolveCli(store.settings.agentPath)
  if (!cli) return [{ id: 'auto', label: 'Auto' }]
  const apiKey = resolveApiKey(store.settings.apiKey)
  const res = await runCliOnce(cli, ['models'], 60_000, apiKey)
  const models = mergeModelLists(parseModels(res.stdout), loadCursorModelCatalog())
  return models.length ? models : [{ id: 'auto', label: 'Auto' }]
}

async function codexModelList(): Promise<ModelInfo[]> {
  try {
    const listed = await listCodexModels(store.settings.codexPath, resolveCodexApiKey(store.settings.codexApiKey))
    return listed.models
  } catch (err) {
    console.error('[codex] model list failed', err)
    return []
  }
}

async function codexInfo(): Promise<{ found: boolean; path?: string; version?: string; status?: string; hasApiKey?: boolean; bundled?: boolean }> {
  const codex = resolveCodex(store.settings.codexPath)
  if (!codex) return { found: false }
  const [version, status] = await Promise.all([codexVersion(codex), codexStatus(codex)])
  return {
    found: true,
    path: codex.display,
    version,
    status,
    hasApiKey: !!resolveCodexApiKey(store.settings.codexApiKey),
    bundled: codex.bundled
  }
}

if (process.env.AGENT_DESKTOP_USER_DATA) app.setPath('userData', process.env.AGENT_DESKTOP_USER_DATA)
// Chromium locks GPUCache under sessionData. A second window sharing that directory fails with
// "Unable to move the cache" / "Gpu Cache Creation failed". App data stays in userData.
const sessionDataDir = usePerProcessSessionData()
if (isWin) app.setAppUserModelId(app.isPackaged ? 'dev.agentdesktop.app' : process.execPath)

app.whenReady().then(() => {
  store = new Store()
  try {
    syncAllManagedSkills(store.settings.skills)
  } catch (err) {
    console.error('[skills] sync failed', err)
  }
  sessions = new SessionManager(store, emitAgent, broadcastState, notifyRunFinished)
  nativeTheme.themeSource = store.settings.theme
  nativeTheme.on('updated', () => {
    if (isWin && win) win.setTitleBarOverlay({ ...overlayColors(), height: 44 })
  })
  if (isMac) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
  registerIpc()
  void applyRemote()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  sessions?.stopAll()
  void publicTunnel.stop()
  void remote.stop()
  store?.flush()
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('will-quit', () => {
  removeDir(sessionDataDir)
})

/** Gives this process its own Chromium profile (GPU cache, HTTP cache, localStorage). */
function usePerProcessSessionData(): string {
  const root = path.join(os.tmpdir(), 'agent-desktop-sessions')
  fs.mkdirSync(root, { recursive: true })
  for (const name of fs.readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid === process.pid || isProcessAlive(pid)) continue
    removeDir(path.join(root, name))
  }
  const dir = path.join(root, String(process.pid))
  removeDir(dir)
  fs.mkdirSync(dir, { recursive: true })
  app.setPath('sessionData', dir)
  return dir
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Cache files can stay locked until the process has fully exited.
  }
}
