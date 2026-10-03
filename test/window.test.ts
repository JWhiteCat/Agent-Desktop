import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  windows: [] as any[], getPath: vi.fn(), setPath: vi.fn(), spawn: vi.fn(),
  environment: { PATH: '/home/test/.local/bin:/usr/bin' },
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system' }
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath, setPath: mocks.setPath, getAppPath: () => '/app' },
  BrowserWindow: class extends EventEmitter {
    options: unknown
    webContents = {
      setWindowOpenHandler: vi.fn(), on: vi.fn(), getURL: vi.fn(), toggleDevTools: vi.fn()
    }
    setMenu = vi.fn()
    setTitleBarOverlay = vi.fn()
    show = vi.fn()
    loadURL = vi.fn()
    loadFile = vi.fn()
    constructor(options: unknown) { super(); this.options = options; mocks.windows.push(this) }
  },
  nativeTheme: mocks.nativeTheme,
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
