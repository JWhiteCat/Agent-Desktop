import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

/** Wallpapers share the window but are never allowed to call application handlers. */
export function isTrustedAppFrame(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, win: BrowserWindow | null): boolean {
  return !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
}
