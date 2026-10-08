import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ContextMenuParams } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  windows: [] as any[], getPath: vi.fn(), setPath: vi.fn(), spawn: vi.fn(),
  buildFromTemplate: vi.fn(), menuPopup: vi.fn(),
  environment: { PATH: '/home/test/.local/bin:/usr/bin' },
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system' }
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath, setPath: mocks.setPath, getAppPath: () => '/app' },
  BrowserWindow: class extends EventEmitter {
    options: unknown
    webContents = {
      setWindowOpenHandler: vi.fn(), on: vi.fn(), getURL: vi.fn(), toggleDevTools: vi.fn(),
      copy: vi.fn(), paste: vi.fn()
    }
    setMenu = vi.fn()
    setTitleBarOverlay = vi.fn()
    show = vi.fn()
    loadURL = vi.fn()
    loadFile = vi.fn()
    constructor(options: unknown) { super(); this.options = options; mocks.windows.push(this) }
  },
  nativeTheme: mocks.nativeTheme,
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
  shell: { openExternal: vi.fn() }
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/main/cli-runtime', () => ({ cliEnvironment: () => mocks.environment }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const tempDirs: string[] = []

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.windows.length = 0
  mocks.buildFromTemplate.mockReturnValue({ popup: mocks.menuPopup })
  mocks.nativeTheme.shouldUseDarkColors = false
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function load(platformName: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { ...platform, value: platformName })
  return import('../src/main/window')
}

type ContextMenuOverrides = Partial<Pick<ContextMenuParams, 'isEditable' | 'selectionText'>> & {
  editFlags?: Partial<ContextMenuParams['editFlags']>
}

function openContextMenu(win: any, overrides: ContextMenuOverrides = {}) {
  const listener = win.webContents.on.mock.calls.find(([event]: [string]) => event === 'context-menu')?.[1]
  expect(listener).toBeTypeOf('function')
  listener({}, {
    x: 42, y: 84, menuSourceType: 'mouse', isEditable: false, selectionText: '', ...overrides,
    editFlags: {
      canUndo: false, canRedo: false, canCut: false, canCopy: false,
      canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false,
      ...overrides.editFlags
    }
  })
  return mocks.buildFromTemplate.mock.lastCall?.[0] as Array<{ label: string; enabled: boolean; click: () => void }> | undefined
}

describe('desktop window platform integration', () => {
  it('keeps native Linux window controls and an application icon without weakening the renderer sandbox', async () => {
    const { createMainWindow, applyWindowTheme } = await load('linux')
    const win = createMainWindow()
    const created = mocks.windows[0]
    expect(created.options).not.toHaveProperty('titleBarStyle')
    expect(created.options).not.toHaveProperty('titleBarOverlay')
    expect(created.options.icon).toBe(path.join('/app', 'resources/icons/512x512.png'))
    expect(created.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true })
    expect(created.setMenu).toHaveBeenCalledExactlyOnceWith(null)
    expect(created.show).not.toHaveBeenCalled()
    created.emit('ready-to-show')
    expect(created.show).toHaveBeenCalledOnce()
    applyWindowTheme(win, 'dark')
    expect(mocks.nativeTheme.themeSource).toBe('dark')
    expect(created.setTitleBarOverlay).not.toHaveBeenCalled()
  })

  it('preserves Windows overlay controls and theme updates', async () => {
    const { createMainWindow, syncTitleBar } = await load('win32')
    const win = createMainWindow()
    expect(mocks.windows[0].options).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { height: 44 } })
    mocks.nativeTheme.shouldUseDarkColors = true
    syncTitleBar(win)
    expect(mocks.windows[0].setTitleBarOverlay).toHaveBeenCalledWith({ color: '#00000000', symbolColor: '#c9c9c9', height: 44 })
  })

  it('preserves macOS traffic lights and the application menu', async () => {
    const { createMainWindow } = await load('darwin')
    createMainWindow()
    expect(mocks.windows[0].options).toMatchObject({ titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 15 } })
    expect(mocks.windows[0].setMenu).not.toHaveBeenCalled()
  })

  it('opens Linux editor paths with spaces as one argument using the desktop CLI environment', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    mocks.spawn.mockReturnValueOnce(child)
    const { openInEditor } = await load('linux')
    const pending = openInEditor('/home/test/my project; literal')
    expect(mocks.spawn).toHaveBeenCalledWith('cursor', ['/home/test/my project; literal'], expect.objectContaining({
      shell: false, detached: true, env: mocks.environment
    }))
    child.emit('spawn')
    await expect(pending).resolves.toBe(true)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('lets callers fall back when the editor is missing or not executable', async () => {
    const child = new EventEmitter()
    mocks.spawn.mockReturnValueOnce(child)
    const { openInEditor } = await load('linux')
    const pending = openInEditor('/home/test/project')
    child.emit('error', Object.assign(new Error('Permission denied'), { code: 'EACCES' }))
    await expect(pending).resolves.toBe(false)
  })
})

describe('desktop copy and paste context menu', () => {
  it.each(['linux', 'win32', 'darwin'] as const)('skips empty menus on %s', async (platformName) => {
    const { createMainWindow } = await load(platformName)
    const win = createMainWindow()
    openContextMenu(win)
    expect(mocks.buildFromTemplate).not.toHaveBeenCalled()
    expect(mocks.menuPopup).not.toHaveBeenCalled()
  })

  it.each(['你好\nhello', ' \n\t '])('copies a non-editable selection without stripping its whitespace: %j', async (selectionText) => {
    const { createMainWindow } = await load('win32')
    const win = createMainWindow()
    const menu = openContextMenu(win, { selectionText, editFlags: { canCopy: true } })!
    expect(menu).toEqual([{ label: '复制', enabled: true, click: expect.any(Function) }])
    expect(mocks.menuPopup).toHaveBeenCalledExactlyOnceWith({ window: win, x: 42, y: 84, sourceType: 'mouse' })
    menu[0].click()
    expect(win.webContents.copy).toHaveBeenCalledOnce()
    expect(win.webContents.paste).not.toHaveBeenCalled()
  })

  it('disables selection copying when Chromium does not permit it', async () => {
    const { createMainWindow } = await load('linux')
    const menu = openContextMenu(createMainWindow(), { selectionText: 'protected text', editFlags: { canCopy: false } })!
    expect(menu).toEqual([{ label: '复制', enabled: false, click: expect.any(Function) }])
  })

  it.each(['linux', 'win32', 'darwin'] as const)('offers native paste in an editable field on %s even without a selection', async (platformName) => {
    const { createMainWindow } = await load(platformName)
    const win = createMainWindow()
    const menu = openContextMenu(win, { isEditable: true, editFlags: { canPaste: true } })!
    expect(menu).toEqual([
      { label: '复制', enabled: false, click: expect.any(Function) },
      { label: '粘贴', enabled: true, click: expect.any(Function) }
    ])
    menu[1].click()
    expect(win.webContents.paste).toHaveBeenCalledOnce()
    expect(win.webContents.copy).not.toHaveBeenCalled()
  })

  it.each([true, false])('preserves copy availability (%s) while disabling paste in a non-pasteable field', async (canCopy) => {
    const { createMainWindow } = await load('win32')
    const menu = openContextMenu(createMainWindow(), {
      isEditable: true, selectionText: canCopy ? 'read-only text' : '', editFlags: { canCopy, canPaste: false }
    })!
    expect(menu.map(({ label, enabled }) => ({ label, enabled }))).toEqual([
      { label: '复制', enabled: canCopy }, { label: '粘贴', enabled: false }
    ])
  })

  it('routes both actions to the window that opened each menu', async () => {
    const { createMainWindow } = await load('win32')
    const first = createMainWindow()
    const second = createMainWindow()
    const options = { isEditable: true, selectionText: 'selected', editFlags: { canCopy: true, canPaste: true } }
    const firstMenu = openContextMenu(first, options)!
    const secondMenu = openContextMenu(second, options)!
    firstMenu[0].click()
    firstMenu[1].click()
    expect(first.webContents.copy).toHaveBeenCalledOnce()
    expect(first.webContents.paste).toHaveBeenCalledOnce()
    expect(second.webContents.copy).not.toHaveBeenCalled()
    expect(second.webContents.paste).not.toHaveBeenCalled()
    secondMenu[0].click()
    secondMenu[1].click()
    expect(second.webContents.copy).toHaveBeenCalledOnce()
    expect(second.webContents.paste).toHaveBeenCalledOnce()
    expect(mocks.menuPopup.mock.calls.map(([options]) => options.window)).toEqual([first, second])
  })

  it('uses the current language whenever an existing window opens its menu', async () => {
    const { createMainWindow } = await load('linux')
    const { setLanguage } = await import('../src/shared/i18n')
    const win = createMainWindow()
    const options = { isEditable: true, editFlags: { canPaste: true } }
    expect(openContextMenu(win, options)!.map(({ label }) => label)).toEqual(['复制', '粘贴'])
    setLanguage('en')
    expect(openContextMenu(win, options)!.map(({ label }) => label)).toEqual(['Copy', 'Paste'])
    setLanguage('zh-CN')
    expect(openContextMenu(win, options)!.map(({ label }) => label)).toEqual(['复制', '粘贴'])
  })
})

describe('per-profile Chromium session storage', () => {
  it('uses private profile directories, leaves live sessions alone and cleans only stale caches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-window-test-'))
    tempDirs.push(dir)
    mocks.getPath.mockReturnValue(dir)
    const root = path.join(dir, 'session-cache')
    fs.mkdirSync(path.join(root, '2147483647'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(root, '2147483647', 'stale'), '')
    fs.mkdirSync(path.join(root, '123456'))
    fs.mkdirSync(path.join(root, 'unrelated'))
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 123456) return true
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' })
    })
    const { installSessionData } = await load('linux')
    const session = installSessionData()
    expect(session).toBe(path.join(root, String(process.pid)))
    expect(mocks.getPath).toHaveBeenCalledWith('userData')
    expect(mocks.setPath).toHaveBeenCalledWith('sessionData', session)
    expect(fs.existsSync(path.join(root, '2147483647'))).toBe(false)
    expect(fs.existsSync(path.join(root, '123456'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'unrelated'))).toBe(true)
    if (platform.value !== 'win32') expect(fs.statSync(session).mode & 0o777).toBe(0o700)
    expect(kill).not.toHaveBeenCalledWith(process.pid, 0)
  })

  it('does not confuse an inaccessible live process with a stale session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-window-test-'))
    tempDirs.push(dir)
    mocks.getPath.mockReturnValue(dir)
    const live = path.join(dir, 'session-cache', '123456')
    fs.mkdirSync(live, { recursive: true })
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Not permitted'), { code: 'EPERM' }) })
    const { installSessionData } = await load('linux')
    installSessionData()
    expect(fs.existsSync(live)).toBe(true)
  })
})
