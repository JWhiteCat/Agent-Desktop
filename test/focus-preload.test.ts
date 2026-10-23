import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../src/shared/api'

const mocks = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { expose: vi.fn(), ipc: new EventEmitter() }
})
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: mocks.ipc }))
const descriptor = Object.getOwnPropertyDescriptor(process, 'isMainFrame')
afterEach(() => {
  mocks.ipc.removeAllListeners()
  if (descriptor) Object.defineProperty(process, 'isMainFrame', descriptor)
  else Reflect.deleteProperty(process, 'isMainFrame')
})

it('buffers the latest notification focus until renderer state is initialized and supports unsubscribe', async () => {
  vi.resetModules()
  Object.defineProperty(process, 'isMainFrame', { configurable: true, value: true })
  await import('../src/preload/index')
  const api = mocks.expose.mock.calls.at(-1)![1] as DesktopApi
  mocks.ipc.emit('thread:focus', {}, 'earlier')
  mocks.ipc.emit('thread:focus', {}, 'latest')
  const focus = vi.fn()
  const off = api.onFocusThread(focus)
  expect(focus).toHaveBeenCalledExactlyOnceWith('latest')
  mocks.ipc.emit('thread:focus', {}, 'next')
  expect(focus).toHaveBeenLastCalledWith('next')
  off()
  mocks.ipc.emit('thread:focus', {}, 'buffered')
  expect(focus).toHaveBeenCalledTimes(2)
})
