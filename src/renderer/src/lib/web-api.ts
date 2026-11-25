import { t as translate } from '@shared/i18n'
import type { DesktopApi } from '@shared/api'

const TOKEN_KEY = 'agent-desktop:remoteToken'
/** The server sends a `transport:ping` every 15s; this much silence means the stream is dead. */
const STALE_MS = 35_000
const WATCHDOG_MS = 5_000
const RETRY_MS = 2_000
const SEND_CONFIRM_MS = 2_000

type Listener = (payload: unknown) => void

/** Resolve an API path against the page directory, so `/c/<id>/` and a LAN URL at `/` both work. */
export function remoteUrl(pageHref: string, path: string): string {
  return new URL(path, new URL('.', pageHref)).href
}

function tokenKey(): string {
  const match = /^\/c\/([a-f0-9]{16})(?:\/|$)/.exec(location.pathname)
  return match ? `${TOKEN_KEY}:${match[1]}` : TOKEN_KEY
}

function takeToken(): string {
  const url = new URL(location.href)
  const fromUrl = url.searchParams.get('token')
  const key = tokenKey()
  if (fromUrl) {
    localStorage.setItem(key, fromUrl)
    url.searchParams.delete('token')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
    return fromUrl
  }
  return localStorage.getItem(key) ?? ''
}

/** `DesktopApi` for a phone browser talking to the desktop app over the LAN. */
export function createWebApi(): DesktopApi {
  const token = takeToken()
  const listeners = new Map<string, Set<Listener>>()

  async function call<T>(name: string, ...args: unknown[]): Promise<T> {
    const res = await fetch(remoteUrl(location.href, `api/rpc/${encodeURIComponent(name)}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token': token },
      body: JSON.stringify(args)
    })
    const body = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as { ok: boolean; result?: T; error?: string }
    if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`)
    return body.result as T
  }

  function emit(channel: string, payload: unknown): void {
    for (const cb of listeners.get(channel) ?? []) cb(payload)
  }

  let connectedOnce = false
  let connection = 0
  let stateRevision = 0
  let received = 0
  let lastActivity = Date.now()
  let retry: ReturnType<typeof setTimeout> | undefined
  let events: EventSource | undefined

  /**
   * Mobile browsers, carrier proxies and the public gateway can leave an EventSource that looks open
   * but no longer delivers anything, or close it for good after an HTTP error. Replace it instead.
   */
  function connect(): void {
    if (retry) clearTimeout(retry)
    retry = undefined
    events?.close?.()
    const source = new EventSource(remoteUrl(location.href, `api/events?token=${encodeURIComponent(token)}`))
    events = source
    lastActivity = Date.now()
    source.onopen = () => {
      if (events !== source) return
      lastActivity = Date.now()
      const currentConnection = ++connection
      // Events sent while disconnected are lost. Refresh history as well as metadata.
      if (connectedOnce) {
        const revision = stateRevision
        void call('state:get').then((s) => {
          // A newer event or reconnect has already supplied a more recent snapshot.
          if (connection === currentConnection && stateRevision === revision) emit('state:changed', s)
        }, () => {})
        emit('transport:reconnect', undefined)
      }
      connectedOnce = true
    }
    source.onmessage = (e) => {
      if (events !== source) return
      lastActivity = Date.now()
      received++
      const { channel, payload } = JSON.parse(e.data) as { channel: string; payload: unknown }
      if (channel === 'transport:ping') return
      if (channel === 'state:changed') stateRevision++
      emit(channel, payload)
    }
    source.onerror = () => {
      // EventSource does not retry after a non-200 response such as a gateway 502.
      if (events === source && source.readyState === 2 && !retry) retry = setTimeout(connect, RETRY_MS)
    }
  }

  function reconnectIfStale(): void {
    if (Date.now() - lastActivity > STALE_MS) connect()
  }

  connect()
  setInterval(reconnectIfStale, WATCHDOG_MS)
  // A backgrounded page loses its stream silently; check as soon as it is visible again.
  globalThis.document?.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconnectIfStale()
  })
  globalThis.window?.addEventListener?.('pageshow', reconnectIfStale)
  globalThis.window?.addEventListener?.('online', () => connect())

  /** Every accepted send broadcasts a state change before replying. Without it, the stream is stuck. */
  async function sendAndVerify(req: unknown): Promise<void> {
    const before = received
    await call('agent:send', req)
    setTimeout(() => {
      if (received === before) connect()
    }, SEND_CONFIRM_MS)
  }

  function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
    let set = listeners.get(channel)
    if (!set) listeners.set(channel, (set = new Set()))
    const l = cb as Listener
    set.add(l)
    return () => set.delete(l)
  }

  return {
    skinPickSource: () => Promise.reject(new Error(translate('壁纸素材仅在桌面端可用。'))),
    skinScanWallpapers: () => Promise.reject(new Error(translate('壁纸素材仅在桌面端可用。'))),
    skinSource: () => Promise.reject(new Error(translate('壁纸素材仅在桌面端可用。'))),
    skinSave: () => Promise.reject(new Error(translate('壁纸素材仅在桌面端可用。'))),
    skinDelete: () => Promise.reject(new Error(translate('壁纸素材仅在桌面端可用。'))),
    platform: 'web',
    isRemote: true,
    getState: () => call('state:get'),
    pickProject: async () => {
      const dir = window.prompt(translate('输入电脑上的项目文件夹路径'))?.trim()
      return dir ? call('project:add', dir) : null
    },
    addProject: (p) => call('project:add', p),
    updateProject: (id, patch) => call('project:update', id, patch),
    removeProject: (id) => call('project:remove', id),
    reorderProjects: (ids) => call('project:reorder', ids),
    collapseAllProjects: () => call('project:collapseAll'),
    createThread: (projectId, mode, model, force, cli) => call('thread:create', projectId, mode, model, force, cli),
    updateThread: (id, patch) => call('thread:update', id, patch),
    deleteThread: (id) => call('thread:delete', id),
    forkThread: (id, throughItemId) => call('thread:fork', id, throughItemId),
    getItems: (id) => call('thread:items', id),
    syncFromCli: (id) => call('thread:syncFromCli', id),
    send: (req) => sendAndVerify(req),
    uploadAttachment: (req) => call('attachment:upload', req),
    readAttachment: (id) => call('attachment:read', id),
    prepareToolImages: (threadId, itemId) => call('tool-image:list', threadId, itemId),
    readToolImage: (threadId, itemId, imageId) => call('tool-image:read', threadId, itemId, imageId),
    copyToolImage: async () => { throw new Error(translate('仅桌面端可用')) },
    openAttachment: async () => { throw new Error(translate('仅桌面端可用')) },
    prepareCommands: (threadId, opts) => call('agent:prepare', threadId, opts),
    stop: (id) => call('agent:stop', id),
    removeQueued: (threadId, messageId) => call('agent:queueRemove', threadId, messageId),
    reorderQueued: (threadId, ids) => call('agent:queueReorder', threadId, ids),
    sendQueuedNow: (threadId, messageId) => call('agent:queueSendNow', threadId, messageId),
    answerQuestion: (threadId, questionId, answers) => call('agent:answerQuestion', threadId, questionId, answers),
    updateSettings: (patch) => call('settings:update', patch),
    usageSummary: (period, cli) => call('usage:summary', period, cli),
    usageQuotas: () => call('usage:quotas'),
    usageQuota: (provider) => call('usage:quota', provider),
    consumeCodexReset: (creditId) => call('usage:consumeCodexReset', creditId),
    listModels: (refresh, provider) => call('cli:models', refresh, provider),
    cliInfo: (provider, refresh) => call('cli:info', provider, refresh),
    login: (provider) => call('cli:login', provider),
    cliInstallStatus: (provider) => call('cli:installStatus', provider),
    installCli: (provider) => call('cli:install', provider),
    updateCli: (provider) => call('cli:update', provider),
    appCliPathStatus: () => Promise.reject(new Error(translate('仅桌面端可用'))),
    installAppCliToPath: () => Promise.reject(new Error(translate('仅桌面端可用'))),
    uninstallAppCliFromPath: () => Promise.reject(new Error(translate('仅桌面端可用'))),
    scanCliSessions: () => call('cli:scan'),
    importCliSessions: (ids) => call('cli:import', ids),
    gitDiff: (cwd) => call('git:diff', cwd),
    openPath: (p) => call('shell:openPath', p),
    openSkillsDir: () => call('shell:openSkills'),
    localMcpList: () => call('local:mcpList'),
    localMcpSave: (req) => call('local:mcpSave', req),
    localMcpToggle: (id, enabled, hash) => call('local:mcpToggle', id, enabled, hash),
    localMcpDelete: (id, hash) => call('local:mcpDelete', id, hash),
    localSkillList: () => call('local:skillList'),
    localSkillCommands: (projectId, threadId) => call('local:skillCommands', projectId, threadId),
    localSkillRead: (id) => call('local:skillRead', id),
    localSkillSave: (req) => call('local:skillSave', req),
    localSkillToggle: (id, enabled) => call('local:skillToggle', id, enabled),
    localSkillDelete: (id) => call('local:skillDelete', id),
    openInEditor: (p, editor) => editor === undefined ? call('shell:openInEditor', p) : call('shell:openInEditor', p, editor),
    runToolbarCommand: () => Promise.reject(new Error(translate('仅桌面端可用'))),
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener')
    },
    grokbotList: () => call('grokbot:list'),
    grokbotHistory: (name) => call('grokbot:history', name),
    grokbotCached: (name) => call('grokbot:cached', name),
    grokbotPoll: (name, cursor, sessionId) => call('grokbot:poll', name, cursor, sessionId),
    grokbotSend: (name, text) => call('grokbot:send', name, text),
    grokbotInterrupt: (name) => call('grokbot:interrupt', name),
    grokbotCreate: (name) => call('grokbot:create', name),
    grokbotAttachments: (name, messages) => call('grokbot:attachments', name, messages),
    grokbotAttachmentData: (sha256) => call('grokbot:attachmentData', sha256),
    grokbotSaveAttachment: () => Promise.reject(new Error(translate('仅桌面端可用'))),
    grokbotRevealAttachment: () => Promise.reject(new Error(translate('仅桌面端可用'))),
    remoteInfo: () => Promise.reject(new Error(translate('仅桌面端可用'))),
    resetRemoteToken: () => Promise.reject(new Error(translate('仅桌面端可用'))),
    onEvent: (cb) => subscribe('agent:event', cb),
    onState: (cb) => subscribe('state:changed', cb),
    onReconnect: (cb) => subscribe('transport:reconnect', cb),
    onFocusThread: (cb) => subscribe('thread:focus', cb)
  }
}
