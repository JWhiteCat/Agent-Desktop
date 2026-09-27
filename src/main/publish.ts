import type { BrowserWindow } from 'electron'
import type { AppState } from '@shared/types'
import type { RemoteServer } from './remote'
import { remoteSafeState } from './remote-runtime'

/** Sends to the desktop window, and to phone browsers when the channel is shared. */
export function publish(win: BrowserWindow | null, remote: RemoteServer, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  if (channel === 'state:changed') remote.broadcast(channel, remoteSafeState(payload as AppState))
  else if (channel === 'agent:event') remote.broadcast(channel, payload)
}
