import path from 'node:path'
import type { AppState, RemoteInfo, Settings } from '@shared/types'
import { lanAddresses, newRemoteToken, RemoteServer, type Handler } from './remote'
import {
  newRemoteClientId,
  PublicTunnel,
  publicRemoteUrl,
  validClientId,
  validatePublicHost,
  validatePublicPort,
  validatePublicUser
} from './public-tunnel'
import type { Store } from './store'

export function remoteSafeSettings(s: Settings): Settings {
  return { ...s, apiKey: '', codexApiKey: '', remoteToken: '' }
}

export function remoteSafeState(state: AppState): AppState {
  return { ...state, settings: remoteSafeSettings(state.settings) }
}

const REMOTE_BLOCKED = new Set(['project:pick', 'remote:info', 'remote:resetToken'])
const REMOTE_ONLY_DESKTOP_SETTINGS: (keyof Settings)[] = [
  'remoteEnabled',
  'remotePort',
  'remoteToken',
  'remoteClientId',
  'remotePublicEnabled',
  'remotePublicUser',
  'remotePublicHost',
  'remotePublicPort'
]

/** What a phone browser may call: no native dialogs, no remote-control settings, no secrets. */
export function handlersForRemote(handlers: Record<string, Handler>, snapshot: () => AppState): Record<string, Handler> {
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

/** Starts and stops the LAN server and the public SSH tunnel to match settings. */
export class RemoteRuntime {
  readonly server = new RemoteServer()
  readonly tunnel = new PublicTunnel()
  private handlers: Record<string, Handler> = {}
  private remoteError: string | undefined
  private publicError: string | undefined

  constructor(
    private readonly getStore: () => Store,
    private readonly snapshot: () => AppState
  ) {}

  bind(handlers: Record<string, Handler>): void {
    this.handlers = handlers
  }

  info(): RemoteInfo {
    const s = this.getStore().settings
    const port = this.server.port ?? s.remotePort
    const publicOn = s.remoteEnabled && s.remotePublicEnabled
    const link =
      publicOn && this.tunnel.status === 'up' && validClientId(s.remoteClientId)
        ? publicRemoteUrl(s.remotePublicHost, s.remotePublicPort, s.remoteClientId, s.remoteToken)
        : undefined
    const tunnelError = publicOn ? this.publicError || this.tunnel.error : undefined
    return {
      enabled: s.remoteEnabled,
      running: this.server.running,
      port,
      urls: [...(this.server.running ? lanAddresses().map((ip) => `http://${ip}:${port}/?token=${s.remoteToken}`) : []), ...(link ? [link] : [])],
      ...(this.remoteError ? { error: this.remoteError } : {}),
      publicStatus: publicOn ? this.tunnel.status : 'off',
      ...(link ? { publicUrl: link } : {}),
      ...(tunnelError ? { publicError: tunnelError } : {})
    }
  }

  /** Starts, restarts or stops the LAN server to match the settings. */
  async apply(): Promise<void> {
    this.remoteError = undefined
    const store = this.getStore()
    const s = store.settings
    if (!s.remoteEnabled) {
      await this.server.stop()
      await this.applyPublicTunnel()
      return
    }
    if (!s.remoteToken) store.updateSettings({ remoteToken: newRemoteToken() })
    try {
      await this.server.start({
        port: s.remotePort,
        token: store.settings.remoteToken,
        clientId: store.settings.remoteClientId,
        handlers: handlersForRemote(this.handlers, this.snapshot),
        devUrl: process.env.ELECTRON_RENDERER_URL,
        staticDir: path.join(__dirname, '../renderer')
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      this.remoteError = code === 'EADDRINUSE' ? `端口 ${s.remotePort} 已被占用，请换一个端口` : err instanceof Error ? err.message : String(err)
      console.error('[remote] start failed', err)
    }
    await this.applyPublicTunnel()
  }

  async stop(): Promise<void> {
    await this.tunnel.stop()
    await this.server.stop()
  }

  /** Starts or stops the public SSH tunnel to match the settings. The LAN server must already be up. */
  private async applyPublicTunnel(): Promise<void> {
    this.publicError = undefined
    const store = this.getStore()
    const s = store.settings
    if (!s.remoteEnabled || !s.remotePublicEnabled || !this.server.running) {
      await this.tunnel.stop()
      if (s.remoteEnabled && s.remotePublicEnabled && !this.server.running) this.publicError = '局域网服务未启动，无法建立公网隧道'
      return
    }
    try {
      if (!validClientId(store.settings.remoteClientId)) store.updateSettings({ remoteClientId: newRemoteClientId() })
      const current = store.settings
      await this.tunnel.start({
        user: validatePublicUser(current.remotePublicUser),
        host: validatePublicHost(current.remotePublicHost),
        port: validatePublicPort(current.remotePublicPort),
        localPort: this.server.port ?? current.remotePort,
        clientId: current.remoteClientId
      })
    } catch (err) {
      await this.tunnel.stop()
      this.publicError = err instanceof Error ? err.message : String(err)
      console.error('[remote] public tunnel failed', err)
    }
  }
}
