import type { BrowserWindow } from 'electron'
import type { AppState } from '@shared/types'
import type { LocalControlServer } from './local-control'
import type { RemoteServer } from './remote'
import { remoteSafeState } from './remote-runtime'

/** Sends to the desktop window, remote browsers, and attached local CLI subscribers when the channel is shared. */
export function publish(
  win: BrowserWindow | null,
  remote: RemoteServer,
  channel: string,
  payload: unknown,
  localControl?: Pick<LocalControlServer, 'broadcast'>
): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  if (channel === 'state:changed') {
    const safe = remoteSafeState(payload as AppState)
    remote.broadcast(channel, safe)
    localControl?.broadcast(channel, safe)
  } else if (channel === 'agent:event') {
    remote.broadcast(channel, payload)
    localControl?.broadcast(channel, payload)
  }
}
