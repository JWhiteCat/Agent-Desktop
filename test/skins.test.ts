import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SKIN, normalizeSkin, normalizeSkins, skinUrl, remoteSkin } from '../src/shared/skins'
import { SkinLibrary, parseSkinRange, parseSteamLibraries, bridgeScript } from '../src/main/skins'
import { remoteSafeState, handlersForRemote } from '../src/main/remote-runtime'
import { Store } from '../src/main/store'
import { DEFAULT_SETTINGS, type AppState } from '../src/shared/types'
import { skinHandlers } from '../src/main/ipc/skins'
import type { IpcDeps } from '../src/main/ipc/deps'
import { isTrustedAppFrame } from '../src/main/ipc/guard'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

const electron = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.dir }, dialog: { showOpenDialog: vi.fn() } }))
let dir: string
let library: SkinLibrary
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-skins-'))
  electron.dir = dir
  library = new SkinLibrary(path.join(dir, 'data', 'sources.json'))
})
afterEach(() => {
  const target = path.resolve(dir)
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('agent-desktop-skins-')) throw new Error('Unexpected test directory')
  fs.rmSync(target, { recursive: true, force: true })
})
function file(name: string, body = '0123456789'): string {
  const target = path.join(dir, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body)
  return target
}
function project(name: string, type = 'Web', entry = 'index.html'): string {
  file(`${name}/${entry}`, '<html><head></head><body>Wallpaper</body></html>')
  file(`${name}/project.json`, JSON.stringify({ title: name, type, file: entry, general: { properties: {
    color: { type: 'color', text: 'Color', value: '1 0 0' },
    speed: { type: 'slider', value: 10, min: 0, max: 20 },
    external: { type: 'file', value: 'C:/private.txt' }
  } } }))
  return path.join(dir, name)
}

describe('skin preferences', () => {
  it('preserves existing appearance and bounds editable values without accepting CSS', () => {
    expect(normalizeSkin(undefined)).toEqual(DEFAULT_SKIN)
    expect(normalizeSkin({ opacity: -1, blur: 300, overlay: NaN, colors: { background: '#123456', text: 'url(secret)' }, background: 'web', sourceId: '../' }))
      .toMatchObject({ opacity: 0, blur: 40, overlay: 0, colors: { background: '#123456' }, background: 'none', sourceId: '' })
    expect(normalizeSkins([{ id: 'default' }, { id: 'a' }, { id: 'a' }])).toHaveLength(1)
  })
  it('migrates old settings and persists custom skins with conversations intact', () => {
    const store = new Store()
    const p = store.addProject(dir)
    store.createThread({ projectId: p.id, title: 'Keep', mode: 'agent', source: 'app' })
    expect(store.settings.skin).toEqual(DEFAULT_SKIN)
    store.updateSettings({ skin: normalizeSkin({ id: 'custom', opacity: 78, colors: { accent: '#abcdef' } }) })
    store.flush()
    const restored = new Store()
    expect(restored.settings.skin.opacity).toBe(78)
    expect(restored.threads[0].title).toBe('Keep')
    restored.flush()
  })
  it('saves, updates and deletes custom skins without deleting source files', async () => {
    const store = new Store()
    const deps = { store, broadcast: vi.fn() } as unknown as IpcDeps
    const handlers = skinHandlers(deps)
    const saved = await handlers['skin:save']({ ...DEFAULT_SKIN, name: 'Saved' }) as typeof DEFAULT_SKIN
    expect(saved.id).not.toBe('default')
    expect(store.settings.skins).toHaveLength(1)
    await handlers['skin:save']({ ...saved, opacity: 45 })
    expect(store.settings.skins[0].opacity).toBe(45)
    expect(store.settings.skins).toHaveLength(1)
    await handlers['skin:delete'](saved.id)
    expect(store.settings.skin).toEqual(DEFAULT_SKIN)
    expect(store.settings.skins).toEqual([])
    expect(() => handlers['skin:delete']('default')).toThrow()
    store.flush()
  })
})
describe('wallpaper sources', () => {
  it('references files without copying and recovers references after restart', async () => {
    const input = file('中文 dir/movie.mp4')
    const s = await library.add(input)
    expect(s.kind).toBe('video')
    expect(fs.readFileSync(input, 'utf8')).toBe('0123456789')
    expect((await new SkinLibrary(path.join(dir, 'data', 'sources.json')).source(s.id)).entry).toBe('movie.mp4')
    fs.unlinkSync(input)
    await expect(library.source(s.id)).rejects.toThrow()
  })
  it('parses mixed case Web projects and only exposes supported properties', async () => {
    const s = await library.add(project('web'))
    expect(s.kind).toBe('web')
    expect(Object.keys(s.properties)).toEqual(['color', 'speed'])
    const response = await library.response(new Request(skinUrl(s)))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'")
    expect(await response.text()).toContain('__agent_skin_bridge__.js')
    const bridge = await library.response(new Request(`skin-asset://${s.id}/__agent_skin_bridge__.js`))
    expect(await bridge.text()).toContain('applyUserProperties')
    expect(bridgeScript(s)).toContain('setPaused')
  })
  it('scans multiple Steam libraries, marks unsupported and broken projects and remembers manual roots', async () => {
    project('steam1/steamapps/workshop/content/431960/one', 'video', 'movie.mp4')
    project('steam2/steamapps/common/wallpaper_engine/projects/myprojects/two')
    project('manual/scene', 'scene', 'scene.pkg')
    file('manual/broken/project.json', '{invalid')
    const entries = await library.scan(path.join(dir, 'manual'), [path.join(dir, 'steam1'), path.join(dir, 'steam2'), path.join(dir, 'steam1', '.')])
    expect(entries.filter(e => e.available)).toHaveLength(2)
    expect(entries.filter(e => !e.available)).toHaveLength(2)
    expect(entries.find(e => e.type === 'scene')?.reason).toBeTruthy()
    const reloaded = new SkinLibrary(path.join(dir, 'data', 'sources.json'))
    expect(await reloaded.scan(undefined, [])).toHaveLength(2)
    expect(parseSteamLibraries('"0" { "path" "D:\\\\Steam" } "1" { "path" "E:\\\\Games\\\\Steam" }')).toEqual(['D:\\Steam', 'E:\\Games\\Steam'])
  })
  it('rejects entry traversal, unregistered sources and files outside selected image/video', async () => {
    const s = await library.add(file('selected/image.png'))
    file('selected/private.txt', 'private')
    expect((await library.response(new Request(`skin-asset://${s.id}/private.txt`))).status).toBe(404)
    expect((await library.response(new Request(`skin-asset://${s.id}/..%2Fprivate.txt`))).status).toBe(404)
    expect((await library.response(new Request(`skin-asset://${'f'.repeat(32)}/image.png`))).status).toBe(404)
    project('bad')
    file('bad/project.json', JSON.stringify({ type: 'web', file: '../selected/private.txt' }))
    await expect(library.add(path.join(dir, 'bad'))).rejects.toThrow()
  })
  it('rejects junction escapes after resolving the actual target', async () => {
    const s = await library.add(project('safe'))
    file('outside/secret.js')
    fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'safe', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await library.response(new Request(`skin-asset://${s.id}/escape/secret.js`))).status).toBe(404)
  })
  it('streams bounded ranges, suffix ranges and HEAD without buffering entire videos', async () => {
    const s = await library.add(file('movie.mp4'))
    const response = await library.response(new Request(skinUrl(s), { headers: { range: 'bytes=2-5' } }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await response.text()).toBe('2345')
    const suffix = await library.response(new Request(skinUrl(s), { headers: { range: 'bytes=-3' } }))
    expect(await suffix.text()).toBe('789')
    const head = await library.response(new Request(skinUrl(s), { method: 'HEAD' }))
    expect(head.headers.get('content-length')).toBe('10')
    expect(await head.text()).toBe('')
    expect((await library.response(new Request(skinUrl(s), { headers: { range: 'bytes=20-' } }))).status).toBe(416)
    expect(parseSkinRange('bytes=1-2,4-5', 10)).toBe(false)
    expect(parseSkinRange('bytes=-0', 10)).toBe(false)
  })
})
describe('remote isolation', () => {
  it('accepts only the app window main frame, rejecting child frames, other windows and detached callers', () => {
    const mainFrame = {}
    const contents = { mainFrame }
    const win = { webContents: contents } as unknown as BrowserWindow
    const event = { sender: contents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
    expect(isTrustedAppFrame(event, win)).toBe(true)
    expect(isTrustedAppFrame({ ...event, senderFrame: {} } as IpcMainInvokeEvent, win)).toBe(false)
    expect(isTrustedAppFrame({ ...event, sender: {} } as IpcMainInvokeEvent, win)).toBe(false)
    expect(isTrustedAppFrame(event, null)).toBe(false)
  })
  it('removes desktop backgrounds and properties from snapshots and blocks every material endpoint', async () => {
    const source = await library.add(project('private'))
    const skin = { ...DEFAULT_SKIN, background: 'web' as const, sourceId: source.id, opacity: 80, properties: { color: '1 0 0' } }
    const state: AppState = { settings: { ...DEFAULT_SETTINGS, skin, skins: [skin] }, projects: [], threads: [], running: [] }
    expect(remoteSafeState(state).settings.skin).toEqual(remoteSkin(skin))
    expect(remoteSafeState(state).settings.skins).toEqual([])
    const update = vi.fn((patch) => ({ ...state.settings, ...patch }))
    const handlers = handlersForRemote({ 'settings:update': update, 'skin:scan': vi.fn(), 'skin:pick': vi.fn(), 'skin:source': vi.fn(), 'skin:save': vi.fn(), 'skin:delete': vi.fn() }, () => state)
    for (const name of ['scan', 'pick', 'source', 'save', 'delete']) expect(handlers[`skin:${name}`]).toBeUndefined()
    await handlers['settings:update']({ skin: { ...DEFAULT_SKIN, opacity: 50 }, skins: [] })
    expect(update.mock.calls[0][0].skin).toMatchObject({ sourceId: source.id, background: 'web', properties: skin.properties, opacity: 50 })
    expect(update.mock.calls[0][0]).not.toHaveProperty('skins')
  })
})
