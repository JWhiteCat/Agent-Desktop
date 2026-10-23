import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { notifyRunFinished } from '../src/main/notify'

const notifications = vi.hoisted(() => [] as EventEmitter[])
vi.mock('electron', () => ({
  Notification: class extends EventEmitter {
    static isSupported() { return true }
    constructor() { super(); notifications.push(this) }
    show() {}
  }
}))
afterEach(() => { notifications.length = 0 })

it.each([false, true])('focuses the notification conversation after a window is ready (loading=%s)', (loading) => {
  const contents = Object.assign(new EventEmitter(), { isLoadingMainFrame: () => loading })
  const win = {
    webContents: contents, isDestroyed: () => false, isMinimized: () => true,
    restore: vi.fn(), show: vi.fn(), focus: vi.fn()
  }
  const getWindow = vi.fn(() => win as unknown as BrowserWindow)
  const send = vi.fn()
  notifyRunFinished({ threadId: 'thread-1', title: 'Done', preview: 'ok', stopped: false, failed: false }, { enabled: true, getWindow, send })
  expect(getWindow).not.toHaveBeenCalled()
  notifications[0].emit('click')
  expect(getWindow).toHaveBeenCalledOnce()
  expect(win.restore).toHaveBeenCalledOnce()
  expect(win.show).toHaveBeenCalledOnce()
  expect(win.focus).toHaveBeenCalledOnce()
  if (loading) {
    expect(send).not.toHaveBeenCalled()
    contents.emit('did-finish-load')
  }
  expect(send).toHaveBeenCalledExactlyOnceWith('thread:focus', 'thread-1')
})
