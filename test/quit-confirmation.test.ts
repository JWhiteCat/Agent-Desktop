import { EventEmitter } from 'node:events'
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { QuitConfirmation } from '../src/main/quit-confirmation'

const mocks = vi.hoisted(() => ({
  on: vi.fn(), quit: vi.fn(), showMessageBox: vi.fn()
}))

vi.mock('electron', () => ({
  app: { on: mocks.on, quit: mocks.quit },
  dialog: { showMessageBox: mocks.showMessageBox }
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

function closeEvent() {
  return {
    defaultPrevented: false,
    preventDefault: vi.fn(function (this: { defaultPrevented: boolean }) { this.defaultPrevented = true })
  }
}

class TestWindow extends EventEmitter {
  destroyed = false
  isDestroyed(): boolean { return this.destroyed }
  close() {
    const event = closeEvent()
    this.emit('close', event)
    if (!event.defaultPrevented) {
      this.destroyed = true
      this.emit('closed')
    }
    return event
  }
}

function setup(platformName: NodeJS.Platform = 'win32') {
  Object.defineProperty(process, 'platform', { ...platform, value: platformName })
  const lifecycle = new EventEmitter()
  mocks.on.mockImplementation((name, listener) => lifecycle.on(name, listener))
  let activeCount = 2
  const windows = [new TestWindow()]
  const onQuit = vi.fn()
  const confirmation = new QuitConfirmation({
    getActiveCount: () => activeCount,
    getWindow: () => windows.at(-1) as unknown as BrowserWindow ?? null,
    onQuit
  })
  const watch = (win: TestWindow) => confirmation.watchWindow(win as unknown as BrowserWindow)
  watch(windows[0])
  const requestQuit = () => {
    const event = closeEvent()
    lifecycle.emit('before-quit', event)
    if (!event.defaultPrevented) for (const win of windows) if (!win.destroyed) win.close()
    return event
  }
  mocks.quit.mockImplementation(requestQuit)
  let respond!: (result: MessageBoxReturnValue) => void
  mocks.showMessageBox.mockImplementation(() => new Promise<MessageBoxReturnValue>((resolve) => { respond = resolve }))
  return {
    win: windows[0], windows, watch, requestQuit, onQuit,
    setActiveCount: (count: number) => { activeCount = count },
    respond: async (response: number) => { respond({ response, checkboxChecked: false }); await Promise.resolve() },
    dialogOptions: () => mocks.showMessageBox.mock.lastCall!.at(-1) as MessageBoxOptions
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  setLanguage('zh-CN')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  setLanguage('system', 'zh-CN')
  vi.restoreAllMocks()
})

describe('desktop quit confirmation', () => {
  it.each(['win32', 'linux'] as const)('keeps the %s window and all cleanup untouched until the user confirms', async (platformName) => {
    const ctx = setup(platformName)
    expect(ctx.win.close().defaultPrevented).toBe(true)
    expect(ctx.win.destroyed).toBe(false)
    expect(ctx.onQuit).not.toHaveBeenCalled()
    expect(mocks.showMessageBox).toHaveBeenCalledExactlyOnceWith(ctx.win, {
      type: 'warning', title: '退出确认',
      message: '仍有 2 个会话未结束，确定退出吗？', detail: '退出将停止这些会话。',
      buttons: ['取消', '停止会话并退出'], defaultId: 0, cancelId: 0, noLink: true
    })

    await ctx.respond(0)
    expect(ctx.win.destroyed).toBe(false)
    expect(ctx.onQuit).not.toHaveBeenCalled()
    expect(mocks.quit).not.toHaveBeenCalled()

    // Cancelling does not consume the close listener: a later attempt still asks.
    expect(ctx.win.close().defaultPrevented).toBe(true)
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2)
    await ctx.respond(1)
    expect(mocks.quit).toHaveBeenCalledOnce()
    expect(ctx.onQuit).toHaveBeenCalledOnce()
    expect(ctx.win.destroyed).toBe(true)
    ctx.requestQuit()
    expect(ctx.onQuit).toHaveBeenCalledOnce()
  })

  it('intercepts application quit before cleanup and does not ask again for its subsequent window close', async () => {
    const ctx = setup()
    expect(ctx.requestQuit().defaultPrevented).toBe(true)
    expect(ctx.onQuit).not.toHaveBeenCalled()
    expect(ctx.win.destroyed).toBe(false)
    await ctx.respond(1)
    expect(ctx.onQuit).toHaveBeenCalledOnce()
    expect(ctx.win.destroyed).toBe(true)
    expect(mocks.showMessageBox).toHaveBeenCalledOnce()
  })

  it('shares one pending dialog between repeated window and application quit requests', async () => {
    const ctx = setup()
    ctx.win.close()
    expect(ctx.win.close().defaultPrevented).toBe(true)
    expect(ctx.requestQuit().defaultPrevented).toBe(true)
    // Finishing tasks while the dialog is open must not bypass the pending decision.
    ctx.setActiveCount(0)
    expect(ctx.win.close().defaultPrevented).toBe(true)
    expect(ctx.requestQuit().defaultPrevented).toBe(true)
    expect(mocks.showMessageBox).toHaveBeenCalledOnce()
    await ctx.respond(0)
    expect(ctx.win.destroyed).toBe(false)
    expect(ctx.onQuit).not.toHaveBeenCalled()
    expect(ctx.requestQuit().defaultPrevented).toBe(false)
    expect(ctx.onQuit).toHaveBeenCalledOnce()
  })

  it('allows idle window close and application quit without a dialog', () => {
    const ctx = setup()
    ctx.setActiveCount(0)
    expect(ctx.win.close().defaultPrevented).toBe(false)
    expect(ctx.onQuit).not.toHaveBeenCalled()
    ctx.requestQuit()
    ctx.requestQuit()
    expect(ctx.onQuit).toHaveBeenCalledOnce()
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
  })

  it('preserves macOS background sessions on window close and confirms a later application quit without a parent', async () => {
    const ctx = setup('darwin')
    expect(ctx.win.close().defaultPrevented).toBe(false)
    expect(ctx.onQuit).not.toHaveBeenCalled()
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    expect(ctx.requestQuit().defaultPrevented).toBe(true)
    expect(mocks.showMessageBox).toHaveBeenCalledExactlyOnceWith(ctx.dialogOptions())
    await ctx.respond(0)
    expect(ctx.onQuit).not.toHaveBeenCalled()
    ctx.requestQuit()
    await ctx.respond(1)
    expect(ctx.onQuit).toHaveBeenCalledOnce()
  })

  it('also guards a recreated main window', async () => {
    const ctx = setup()
    ctx.setActiveCount(0)
    ctx.win.close()
    const next = new TestWindow()
    ctx.windows.push(next)
    ctx.watch(next)
    ctx.setActiveCount(1)
    expect(next.close().defaultPrevented).toBe(true)
    expect(mocks.showMessageBox.mock.lastCall![0]).toBe(next)
    await ctx.respond(0)
    expect(next.destroyed).toBe(false)
  })

  it('reads the active language again after cancellation', async () => {
    const ctx = setup()
    ctx.win.close()
    await ctx.respond(0)
    setLanguage('en')
    ctx.win.close()
    const options = ctx.dialogOptions()
    expect(options.title).toBe('Confirm quit')
    expect(options.message).toContain('2')
    expect(options.buttons).toEqual(['Cancel', 'Stop conversations and quit'])
    expect(JSON.stringify(options)).not.toMatch(/\p{Script=Han}/u)
    await ctx.respond(0)
  })

  it('keeps running when the native dialog fails and allows another attempt', async () => {
    const ctx = setup()
    const error = new Error('Dialog failed')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.showMessageBox.mockRejectedValueOnce(error)
    ctx.requestQuit()
    await Promise.resolve()
    expect(log).toHaveBeenCalledWith('[quit] Confirmation failed', error)
    expect(ctx.win.destroyed).toBe(false)
    expect(ctx.onQuit).not.toHaveBeenCalled()
    expect(ctx.requestQuit().defaultPrevented).toBe(true)
    await ctx.respond(1)
    expect(ctx.onQuit).toHaveBeenCalledOnce()
  })
})
