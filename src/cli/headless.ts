import type { AgentEvent, AppState, CliProvider, ModelInfo } from '@shared/types'
import { setLanguage } from '@shared/i18n'
import { cleanupAcpUsagePreload } from '../main/acp-usage'
import { gitDiff } from '../main/git'
import { acquireHeadlessLock, HeadlessLockConflictError, type AcquiredHeadlessLock } from '../main/headless-lock'
import { attachmentHandlers } from '../main/ipc/attachments'
import { cliHandlers } from '../main/ipc/cli'
import type { IpcDeps } from '../main/ipc/deps'
import { projectHandlers } from '../main/ipc/projects'
import { threadHandlers } from '../main/ipc/threads'
import { usageHandlers } from '../main/ipc/usage'
import { handlersForLocalCli } from '../main/local-control'
import { configureManagedCliDirectory } from '../main/managed-cli-location'
import type { Handler } from '../main/remote'
import { remoteSafeState } from '../main/remote-runtime'
import { SessionManager } from '../main/sessions'
import { syncAllManagedSkills } from '../main/skills'
import { Store } from '../main/store'
import { CliError, EXIT_CONFLICT, EXIT_ERROR, type CliRuntime } from './types'

type ListenerSet = {
  onEvent?: (event: AgentEvent) => void
  onState?: (state: AppState) => void
  onDisconnect?: (err?: Error) => void
}

export class HeadlessCliRuntime implements CliRuntime {
  readonly mode = 'headless' as const
  readonly dataDir: string
  private readonly store: Store
  private readonly sessions: SessionManager
  private readonly handlers: Record<string, Handler>
  private readonly listeners = new Set<ListenerSet>()
  private readonly lock: AcquiredHeadlessLock
  private closed = false

  constructor(dataDir: string, command?: string) {
    this.dataDir = dataDir
    try {
      this.lock = acquireHeadlessLock(dataDir, command)
    } catch (err) {
      if (err instanceof HeadlessLockConflictError) {
        throw new CliError(
          `${err.message}. Start Agent Desktop or wait for the other CLI command to finish.`,
          EXIT_CONFLICT
        )
      }
      throw err
    }

    try {
      this.store = new Store({ dataDir })
      configureManagedCliDirectory(this.store.dataDir)
      const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'
      setLanguage(this.store.settings.language, locale)
      try {
        syncAllManagedSkills(this.store.settings.skills)
      } catch {
        // skill sync failure should not block CLI commands
      }

      const modelsCache = new Map<CliProvider, ModelInfo[]>()
      const snapshot = (): AppState => ({
        systemLocale: locale,
        projects: this.store.projects,
        threads: this.store.threads,
        settings: this.store.settings,
        running: this.sessions.running(),
        starting: this.sessions.starting(),
        waitingForInput: this.sessions.waitingForInput(),
        queued: this.sessions.queued()
      })

      const broadcast = (): void => {
        const safe = remoteSafeState(snapshot())
        for (const sub of this.listeners) sub.onState?.(safe)
      }
      const emitAgent = (ev: AgentEvent): void => {
        for (const sub of this.listeners) sub.onEvent?.(ev)
      }

      this.sessions = new SessionManager(this.store, emitAgent, broadcast, () => {})

      const deps: IpcDeps = {
        store: this.store,
        sessions: this.sessions,
        modelsCache,
        snapshot,
        broadcast,
        getWindow: () => null,
        applyTheme: () => {},
        applyRemote: async () => {},
        remoteInfo: () => ({
          enabled: this.store.settings.remoteEnabled,
          running: false,
          port: this.store.settings.remotePort,
          urls: [],
          publicStatus: 'off'
        })
      }

      const rawHandlers: Record<string, Handler> = {
        'state:get': () => snapshot(),
        ...projectHandlers(deps),
        ...threadHandlers(deps),
        ...attachmentHandlers(deps),
        ...cliHandlers(deps),
        ...usageHandlers(deps),
        'git:diff': (cwd: string) => gitDiff(cwd)
      }
      this.handlers = handlersForLocalCli(rawHandlers, snapshot)
    } catch (err) {
      this.lock.release()
      throw err
    }
  }

  async call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = Object.hasOwn(this.handlers, channel) ? this.handlers[channel] : undefined
    if (!fn) throw new CliError(`Unsupported CLI RPC channel: ${channel}`, EXIT_ERROR)
    return (await fn(...args)) as T
  }

  async subscribe(listeners: ListenerSet): Promise<() => void> {
    this.listeners.add(listeners)
    return () => {
      this.listeners.delete(listeners)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.sessions.stopAll()
      this.store.flush()
      cleanupAcpUsagePreload()
    } finally {
      this.listeners.clear()
      this.lock.release()
    }
  }
}
