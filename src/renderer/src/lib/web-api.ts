import type { DesktopApi } from '@shared/api'

const TOKEN_KEY = 'agent-desktop:remoteToken'

type Listener = (payload: unknown) => void

function takeToken(): string {
  const url = new URL(location.href)
  const fromUrl = url.searchParams.get('token')
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl)
    url.searchParams.delete('token')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
    return fromUrl
  }
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

/** `DesktopApi` for a phone browser talking to the desktop app over the LAN. */
export function createWebApi(): DesktopApi {
  const token = takeToken()
  const listeners = new Map<string, Set<Listener>>()

  async function call<T>(name: string, ...args: unknown[]): Promise<T> {
    const res = await fetch(`/api/rpc/${encodeURIComponent(name)}`, {
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
  const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`)
  events.onopen = () => {
    // Events sent while disconnected are lost; refetch the state after a reconnect.
    if (connectedOnce) void call('state:get').then((s) => emit('state:changed', s), () => {})
    connectedOnce = true
  }
  events.onmessage = (e) => {
    const { channel, payload } = JSON.parse(e.data) as { channel: string; payload: unknown }
    emit(channel, payload)
  }

  function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
    let set = listeners.get(channel)
    if (!set) listeners.set(channel, (set = new Set()))
    const l = cb as Listener
    set.add(l)
    return () => set.delete(l)
  }

  return {
    platform: 'web',
    isRemote: true,
    getState: () => call('state:get'),
    pickProject: async () => {
      const dir = window.prompt('输入电脑上的项目文件夹路径')?.trim()
      return dir ? call('project:add', dir) : null
    },
    addProject: (p) => call('project:add', p),
    updateProject: (id, patch) => call('project:update', id, patch),
    removeProject: (id) => call('project:remove', id),
    reorderProjects: (ids) => call('project:reorder', ids),
    createThread: (projectId, mode, model) => call('thread:create', projectId, mode, model),
    updateThread: (id, patch) => call('thread:update', id, patch),
    deleteThread: (id) => call('thread:delete', id),
    forkThread: (id, throughItemId) => call('thread:fork', id, throughItemId),
    getItems: (id) => call('thread:items', id),
    syncFromCli: (id) => call('thread:syncFromCli', id),
    send: (req) => call('agent:send', req),
    stop: (id) => call('agent:stop', id),
    answerQuestion: (threadId, questionId, answers) => call('agent:answerQuestion', threadId, questionId, answers),
    updateSettings: (patch) => call('settings:update', patch),
    listModels: (refresh) => call('cli:models', refresh),
    cliInfo: () => call('cli:info'),
    login: () => call('cli:login'),
    scanCliSessions: () => call('cli:scan'),
    importCliSessions: (ids) => call('cli:import', ids),
    gitDiff: (cwd) => call('git:diff', cwd),
    openPath: (p) => call('shell:openPath', p),
    openSkillsDir: () => call('shell:openSkills'),
    openInEditor: (p) => call('shell:openInEditor', p),
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener')
    },
    remoteInfo: () => Promise.reject(new Error('仅桌面端可用')),
    resetRemoteToken: () => Promise.reject(new Error('仅桌面端可用')),
    onEvent: (cb) => subscribe('agent:event', cb),
    onState: (cb) => subscribe('state:changed', cb),
    onFocusThread: (cb) => subscribe('thread:focus', cb)
  }
}
