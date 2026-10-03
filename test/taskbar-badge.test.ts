import path from 'node:path'
import type { BrowserWindow, NativeImage } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnreadTaskbarBadge } from '../src/main/taskbar-badge'

const mocks = vi.hoisted(() => ({
  getFileIcon: vi.fn(), createFromBitmap: vi.fn(), createFromPath: vi.fn(), createFromBuffer: vi.fn(),
  mkdirSync: vi.fn(), writeFileSync: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getFileIcon: mocks.getFileIcon },
  nativeImage: { createFromBitmap: mocks.createFromBitmap, createFromPath: mocks.createFromPath, createFromBuffer: mocks.createFromBuffer }
}))
vi.mock('node:fs', () => ({ default: { mkdirSync: mocks.mkdirSync, writeFileSync: mocks.writeFileSync } }))

function image(size = 64, empty = false): NativeImage {
  return {
    isEmpty: () => empty,
    resize: vi.fn(({ width }: { width: number }) => image(width)),
    toBitmap: () => Buffer.alloc(size * size * 4, 30),
    toPNG: () => Buffer.from(`png-${size}`)
  } as unknown as NativeImage
}

function windowMock() {
  return { isDestroyed: vi.fn(() => false), setIcon: vi.fn(), setAppDetails: vi.fn() }
}

function fixture() {
  const win = windowMock()
  let current = win as typeof win | null
  const options = {
    getWindow: () => current as unknown as BrowserWindow | null,
    appId: 'dev.agentdesktop.app', iconPath: path.resolve('electron.exe'), cacheDir: path.resolve('badge-cache')
  }
  return { win, options, badge: new UnreadTaskbarBadge(options), setWindow: (next: typeof win | null) => { current = next } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function initialized() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('unread taskbar badge controller', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let original: NativeImage
  let errors: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    vi.resetAllMocks()
    original = image()
    mocks.getFileIcon.mockResolvedValue(original)
    mocks.createFromBitmap.mockImplementation((bitmap, { width, height }) => {
      if (bitmap.length !== width * height * 4) throw new Error('invalid buffer size')
      return image(width)
    })
    mocks.createFromBuffer.mockImplementation(() => image())
    mocks.createFromPath.mockImplementation(() => image())
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    vi.restoreAllMocks()
  })

  it('applies the latest unread count after one asynchronous icon initialization', async () => {
    const pending = deferred<NativeImage>()
    mocks.getFileIcon.mockReturnValue(pending.promise)
    const { badge, win, options } = fixture()
    badge.sync(1)
    badge.sync(12)
    badge.sync(100)
    expect(mocks.getFileIcon).toHaveBeenCalledExactlyOnceWith(options.iconPath, { size: 'normal' })
    expect(win.setIcon).not.toHaveBeenCalled()
    pending.resolve(original)
    await initialized()
    expect(win.setIcon).toHaveBeenCalledOnce()
    expect(win.setAppDetails).toHaveBeenCalledExactlyOnceWith({
      appId: options.appId, appIconPath: path.join(options.cacheDir, 'unread-99plus.ico'), appIconIndex: 0
    })
    expect(mocks.createFromBitmap).toHaveBeenCalledTimes(4)
    expect(mocks.mkdirSync).toHaveBeenCalledExactlyOnceWith(options.cacheDir, { recursive: true })
  })

  it('normalizes high-DPI shell representations before painting the badge', async () => {
    // At 150% scaling a resized 16-DIP shell image can carry a 24-pixel bitmap.
    vi.mocked(original.resize).mockImplementation(({ width }) => image((width ?? 32) * 1.5))
    const { badge, win } = fixture()
    badge.sync(12)
    await initialized()
    expect(errors).not.toHaveBeenCalled()
    expect(win.setIcon).toHaveBeenCalledOnce()
    expect(mocks.createFromBitmap).toHaveBeenCalledTimes(4)
  })

  it.each(['read', 'delete', 'restore'])('restores the executable icon when unread tasks %s to zero', async (action) => {
    const { badge, win, options } = fixture()
    badge.sync(12)
    await initialized()
    if (action === 'restore') badge.restore()
    else badge.sync(0)
    expect(win.setIcon).toHaveBeenLastCalledWith(original)
    expect(win.setAppDetails).toHaveBeenLastCalledWith({ appId: options.appId, appIconPath: options.iconPath, appIconIndex: 0 })
    expect(mocks.writeFileSync).toHaveBeenCalledOnce()
    badge.sync(0)
    expect(win.setIcon).toHaveBeenCalledTimes(2)
  })

  it('does not draw a badge when the latest count becomes zero during initialization', async () => {
    const pending = deferred<NativeImage>()
    mocks.getFileIcon.mockReturnValue(pending.promise)
    const { badge, win, options } = fixture()
    badge.sync(12)
    badge.sync(0)
    pending.resolve(original)
    await initialized()
    expect(win.setIcon).toHaveBeenCalledExactlyOnceWith(original)
    expect(win.setAppDetails).toHaveBeenCalledExactlyOnceWith({ appId: options.appId, appIconPath: options.iconPath, appIconIndex: 0 })
    expect(mocks.writeFileSync).not.toHaveBeenCalled()
  })

  it('restores the original icon after pending initialization even when state arrives during quit', async () => {
    const pending = deferred<NativeImage>()
    mocks.getFileIcon.mockReturnValue(pending.promise)
    const { badge, win, options } = fixture()
    badge.sync(1)
    badge.restore()
    badge.sync(12)
    pending.resolve(original)
    await initialized()
    expect(win.setIcon).toHaveBeenCalledExactlyOnceWith(original)
    expect(win.setAppDetails).toHaveBeenCalledExactlyOnceWith({ appId: options.appId, appIconPath: options.iconPath, appIconIndex: 0 })
    expect(mocks.writeFileSync).not.toHaveBeenCalled()
  })

  it('ignores later task updates once quitting has restored an initialized icon', async () => {
    const { badge, win, options } = fixture()
    badge.sync(1)
    await initialized()
    badge.restore()
    const iconsApplied = win.setIcon.mock.calls.length
    const detailsApplied = win.setAppDetails.mock.calls.length
    badge.sync(12)
    badge.sync(100)
    expect(win.setIcon).toHaveBeenCalledTimes(iconsApplied)
    expect(win.setAppDetails).toHaveBeenCalledTimes(detailsApplied)
    expect(win.setIcon).toHaveBeenLastCalledWith(original)
    expect(win.setAppDetails).toHaveBeenLastCalledWith({ appId: options.appId, appIconPath: options.iconPath, appIconIndex: 0 })
    expect(mocks.writeFileSync).toHaveBeenCalledOnce()
  })

  it('skips the same displayed label and reuses a previously generated icon', async () => {
    const { badge, win } = fixture()
    badge.sync(100)
    await initialized()
    const cappedIcon = win.setIcon.mock.calls[0][0]
    badge.sync(1_000)
    expect(win.setIcon).toHaveBeenCalledOnce()
    expect(mocks.writeFileSync).toHaveBeenCalledOnce()
    badge.sync(12)
    badge.sync(100)
    expect(win.setIcon).toHaveBeenLastCalledWith(cappedIcon)
    expect(mocks.writeFileSync).toHaveBeenCalledTimes(2)
  })

  it('waits for a live window and reapplies the same label to a replacement window', async () => {
    const { badge, win, setWindow } = fixture()
    win.isDestroyed.mockReturnValue(true)
    badge.sync(1)
    await initialized()
    expect(win.setIcon).not.toHaveBeenCalled()
    setWindow(null)
    badge.sync(1)
    expect(mocks.writeFileSync).not.toHaveBeenCalled()
    win.isDestroyed.mockReturnValue(false)
    setWindow(win)
    badge.sync(1)
    expect(win.setIcon).toHaveBeenCalledOnce()
    const replacement = windowMock()
    setWindow(replacement)
    badge.sync(1)
    expect(replacement.setIcon).toHaveBeenCalledExactlyOnceWith(win.setIcon.mock.calls[0][0])
    expect(mocks.writeFileSync).toHaveBeenCalledOnce()
  })

  it.each(['rejected', 'empty'])('keeps the original icon and logs %s initialization failure once', async (failure) => {
    if (failure === 'rejected') mocks.getFileIcon.mockRejectedValue(new Error('Icon unavailable'))
    else mocks.getFileIcon.mockResolvedValue(image(64, true))
    const { badge, win } = fixture()
    expect(() => badge.sync(1)).not.toThrow()
    await initialized()
    badge.sync(12)
    expect(errors).toHaveBeenCalledOnce()
    expect(mocks.getFileIcon).toHaveBeenCalledOnce()
    expect(win.setIcon).not.toHaveBeenCalled()
    expect(mocks.writeFileSync).not.toHaveBeenCalled()
  })

  it('treats icon cache failure as nonfatal and retries on the next state update', async () => {
    mocks.writeFileSync.mockImplementationOnce(() => { throw new Error('Cache not writable') })
    const { badge, win } = fixture()
    expect(() => badge.sync(1)).not.toThrow()
    await initialized()
    expect(errors).toHaveBeenCalledOnce()
    expect(win.setIcon).not.toHaveBeenCalled()
    expect(() => badge.sync(1)).not.toThrow()
    expect(win.setIcon).toHaveBeenCalledOnce()
    expect(mocks.getFileIcon).toHaveBeenCalledOnce()
    expect(mocks.writeFileSync).toHaveBeenCalledTimes(2)
  })

  it.each(['darwin', 'linux'])('does no native or file work on %s', (platformName) => {
    Object.defineProperty(process, 'platform', { ...platform, value: platformName })
    const { badge, win } = fixture()
    badge.sync(1)
    badge.restore()
    expect(mocks.getFileIcon).not.toHaveBeenCalled()
    expect(mocks.writeFileSync).not.toHaveBeenCalled()
    expect(win.setIcon).not.toHaveBeenCalled()
    expect(win.setAppDetails).not.toHaveBeenCalled()
  })
})
