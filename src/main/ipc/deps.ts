import type { BrowserWindow } from 'electron'
import type { AppState, CliProvider, ModelInfo, RemoteInfo, Settings } from '@shared/types'
import type { SessionManager } from '../sessions'
import type { Store } from '../store'

/** What IPC handlers may use. They do not own the window, the tunnel, or process lifetime. */
export interface IpcDeps {
  store: Store
  sessions: SessionManager
  modelsCache: Map<CliProvider, ModelInfo[]>
  snapshot(): AppState
  broadcast(): void
  getWindow(): BrowserWindow | null
  applyTheme(theme: Settings['theme']): void
  applyRemote(): Promise<void>
  remoteInfo(): RemoteInfo
}
