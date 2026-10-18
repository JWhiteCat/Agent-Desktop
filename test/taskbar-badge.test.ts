import { EventEmitter } from 'node:events'
import type { BrowserWindow, NativeImage } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { getTaskCounts } from '../src/shared/task-counts'
import type { ThreadMeta } from '../src/shared/types'
import { UnreadTaskbarBadge } from '../src/main/taskbar-badge'

const mocks = vi.hoisted(() => ({ createFromBitmap: vi.fn() }))
vi.mock('electron', () => ({ nativeImage: { createFromBitmap: mocks.createFromBitmap } }))

function image(empty = false): NativeImage {
  return { isEmpty: () => empty } as NativeImage
}

function windowMock() {
  return Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    setOverlayIcon: vi.fn()
  })
}

function fixture() {
  const win = windowMock()
  let current = win as typeof win | null
  const badge = new UnreadTaskbarBadge({ getWindow: () => current as unknown as BrowserWindow | null })
  return { win, badge, setWindow: (next: typeof win | null) => { current = next } }
}

describe('unread taskbar badge controller', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let errors: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    vi.useFakeTimers()
    vi.resetAllMocks()
    mocks.createFromBitmap.mockImplementation(() => image())
    setLanguage('en')
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', platform)
    setLanguage('system', 'zh-CN')
    vi.restoreAllMocks()
  })

  it('sets a native taskbar overlay with the unread number and accessible description', () => {
    const { badge, win } = fixture()
    badge.sync(12)
    expect(mocks.createFromBitmap).toHaveBeenCalledOnce()
    const [bitmap, options] = mocks.createFromBitmap.mock.calls[0]
    expect(bitmap).toBeInstanceOf(Buffer)
    expect(bitmap).toHaveLength(32 * 32 * 4)
    expect(options).toEqual({ width: 32, height: 32, scaleFactor: 1 })
    expect(win.setOverlayIcon).toHaveBeenCalledExactlyOnceWith(mocks.createFromBitmap.mock.results[0].value, '12 Unread')
    expect(errors).not.toHaveBeenCalled()
  })

  it('shows a waiting question count and clears the overlay when viewed before answering', () => {
    const { badge, win } = fixture()
    const thread = { id: 'waiting', unread: true } as ThreadMeta
    const state = { threads: [thread], running: [thread.id], waitingForInput: [thread.id] }
    badge.sync(getTaskCounts(state).unread)
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(expect.anything(), '1 Unread')
    thread.unread = false
    badge.sync(getTaskCounts(state).unread)
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
    expect(state.waitingForInput).toEqual(['waiting'])
  })

  it('caps the displayed count and reuses cached overlays after a count changes back', () => {
    const { badge, win } = fixture()
    badge.sync(100)
    const cappedIcon = win.setOverlayIcon.mock.calls[0][0]
    badge.sync(1_000)
    expect(win.setOverlayIcon).toHaveBeenCalledOnce()
    badge.sync(12)
    badge.sync(100)
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(cappedIcon, '99+ Unread')
    expect(mocks.createFromBitmap).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it.each(['read', 'delete', 'quit'])('clears the native overlay when unread tasks %s to zero', (action) => {
    const { badge, win } = fixture()
    badge.sync(12)
    if (action === 'quit') badge.restore()
    else badge.sync(0)
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
    expect(vi.getTimerCount()).toBe(0)
    badge.sync(0)
    vi.advanceTimersByTime(15_000)
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(2)
    expect(mocks.createFromBitmap).toHaveBeenCalledOnce()
  })

  it('clears a zero-count window without generating any bitmap or refresh timer', () => {
    const { badge, win } = fixture()
    badge.sync(0)
    expect(win.setOverlayIcon).toHaveBeenCalledExactlyOnceWith(null, '')
    expect(mocks.createFromBitmap).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['show', 'restore'])('reapplies the same count when the window emits %s', (event) => {
    const { badge, win } = fixture()
    badge.sync(2)
    const overlay = win.setOverlayIcon.mock.calls[0][0]
    win.emit(event)
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(overlay, '2 Unread')
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(2)
    expect(mocks.createFromBitmap).toHaveBeenCalledOnce()
  })

  it('periodically reasserts the overlay without renderer events while the window is in the background', () => {
    const { badge, win } = fixture()
    badge.sync(2)
    vi.advanceTimersByTime(4_999)
    expect(win.setOverlayIcon).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(5_000)
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(3)
    expect(mocks.createFromBitmap).toHaveBeenCalledOnce()
  })

  it('waits for a live window, then applies the count when one is supplied', () => {
    const { badge, win, setWindow } = fixture()
    setWindow(null)
    badge.sync(1)
    expect(mocks.createFromBitmap).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    setWindow(win)
    win.isDestroyed.mockReturnValue(true)
    badge.sync(1)
    expect(win.setOverlayIcon).not.toHaveBeenCalled()
    win.isDestroyed.mockReturnValue(false)
    badge.sync(1)
    expect(win.setOverlayIcon).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('moves refresh listeners and the count to a replacement window', () => {
    const { badge, win, setWindow } = fixture()
    badge.sync(1)
    const replacement = windowMock()
    setWindow(replacement)
    badge.sync(1)
    expect(replacement.setOverlayIcon).toHaveBeenCalledExactlyOnceWith(win.setOverlayIcon.mock.calls[0][0], '1 Unread')
    expect(win.listenerCount('show')).toBe(0)
    expect(win.listenerCount('restore')).toBe(0)
    expect(win.listenerCount('closed')).toBe(0)
    win.emit('show')
    win.emit('restore')
    expect(win.setOverlayIcon).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(5_000)
    expect(replacement.setOverlayIcon).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    expect(mocks.createFromBitmap).toHaveBeenCalledOnce()
  })

  it('detaches listeners and stops refresh when the window closes', () => {
    const { badge, win } = fixture()
    badge.sync(1)
    win.isDestroyed.mockReturnValue(true)
    win.emit('closed')
    expect(win.listenerCount('show')).toBe(0)
    expect(win.listenerCount('restore')).toBe(0)
    expect(win.listenerCount('closed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(15_000)
    expect(win.setOverlayIcon).toHaveBeenCalledOnce()
  })

  it('ignores state and window events after quit restores the overlay', () => {
    const { badge, win } = fixture()
    badge.sync(1)
    badge.restore()
    badge.sync(12)
    win.emit('show')
    win.emit('restore')
    vi.advanceTimersByTime(15_000)
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(2)
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
    expect(win.listenerCount('show')).toBe(0)
    expect(win.listenerCount('restore')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['throws', 'empty'])('retries an overlay bitmap that %s without interrupting task updates', (failure) => {
    if (failure === 'throws') mocks.createFromBitmap.mockImplementationOnce(() => { throw new Error('Bitmap unavailable') })
    else mocks.createFromBitmap.mockReturnValueOnce(image(true))
    const { badge, win } = fixture()
    expect(() => badge.sync(1)).not.toThrow()
    expect(errors).toHaveBeenCalledOnce()
    expect(win.setOverlayIcon).not.toHaveBeenCalled()
    badge.sync(1)
    expect(win.setOverlayIcon).toHaveBeenCalledOnce()
    expect(mocks.createFromBitmap).toHaveBeenCalledTimes(2)
  })

  it('retries a failed shell update on the background refresh without regenerating the overlay', () => {
    const { badge, win } = fixture()
    win.setOverlayIcon.mockImplementationOnce(() => { throw new Error('Taskbar not ready') })
    expect(() => badge.sync(1)).not.toThrow()
    expect(errors).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(5_000)
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(2)
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(mocks.createFromBitmap.mock.results[0].value, '1 Unread')
    expect(mocks.createFromBitmap).toHaveBeenCalledOnce()
  })

  it.each(['darwin', 'linux'])('does no native or timer work on %s', (platformName) => {
    Object.defineProperty(process, 'platform', { ...platform, value: platformName })
    const { badge, win } = fixture()
    badge.sync(1)
    badge.restore()
    expect(mocks.createFromBitmap).not.toHaveBeenCalled()
    expect(win.setOverlayIcon).not.toHaveBeenCalled()
    expect(win.listenerCount('show')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
