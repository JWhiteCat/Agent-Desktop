import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
const clipboardWrite = vi.hoisted(() => vi.fn(async (_items: any[]) => {}))
vi.mock('electron', () => ({
  shell: { openPath: vi.fn() },
  clipboard: { write: clipboardWrite },
  ClipboardItem: class { constructor(public data: Record<string, Blob>) {} },
  nativeImage: { createFromBuffer: (bytes: Buffer) => ({ isEmpty: () => false, toPNG: () => bytes }) }
}))
import { attachmentHandlers } from '../src/main/ipc/attachments'
import { imageCapture } from '../src/main/tool-images'
import { handlersForRemote } from '../src/main/remote-runtime'
import { RemoteServer } from '../src/main/remote'
import { createWebApi } from '../src/renderer/src/lib/web-api'
import { DEFAULT_SETTINGS, type ToolItem } from '../src/shared/types'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK7sAAAAASUVORK5CYII='
let dir: string, store: any, item: ToolItem, handlers: ReturnType<typeof attachmentHandlers>, server: RemoteServer
beforeEach(() => {
  clipboardWrite.mockClear()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-image-transport-'))
  item = { kind: 'tool', id: 'i', callId: 'c', tool: 'image', args: {}, startedAt: 1, status: 'success' }
  const thread = { id: 't', projectId: 'p', cwd: dir }
  store = { dataDir: dir, threads: [thread], items: () => [item], thread: (id: string) => id === 't' ? thread : undefined, project: () => ({ path: dir }), markItemsDirty: vi.fn() }
  imageCapture(store, dir)(item, [{ type: 'image', mimeType: 'image/png', data: PNG }])
  handlers = attachmentHandlers({ store } as any)
  server = new RemoteServer()
})
afterEach(async () => { await server.stop(); vi.unstubAllGlobals(); fs.rmSync(dir, { recursive: true, force: true }) })
describe('tool image IPC/remote separation', () => {
  it('copies real image/png through current Electron API after validating ownership', async () => {
    await handlers['tool-image:copy']('t', 'i', item.images![0].id, PNG)
    expect(clipboardWrite).toHaveBeenCalledTimes(1)
    const blob = clipboardWrite.mock.calls[0]?.[0] as any
    expect(blob[0].data['image/png']).toBeInstanceOf(Blob)
    expect(Buffer.from(await blob[0].data['image/png'].arrayBuffer()).toString('base64')).toBe(PNG)
  })
  it('does not change clipboard on invalid owner or payload', async () => {
    await expect(handlers['tool-image:copy']('other', 'i', item.images![0].id, PNG)).rejects.toThrow()
    await expect(handlers['tool-image:copy']('t', 'i', item.images![0].id, 'invalid')).rejects.toThrow()
    expect(clipboardWrite).not.toHaveBeenCalled()
  })
  it('blocks desktop clipboard remotely but permits authenticated scoped image retrieval', async () => {
    const state = { projects: [], threads: [], running: [], settings: DEFAULT_SETTINGS }
    const safe = handlersForRemote(handlers, () => state)
    expect(safe['tool-image:copy']).toBeUndefined()
    await server.start({ port: 0, token: 'test-token', clientId: 'aaaaaaaaaaaaaaaa', handlers: safe })
    const rpc = (name: string, args: unknown[], token = 'test-token') => fetch(`http://127.0.0.1:${server.port}/api/rpc/${name}`, { method: 'POST', headers: { 'x-token': token, 'content-type': 'application/json' }, body: JSON.stringify(args) })
    const args = ['t', 'i', item.images![0].id]
    expect((await rpc('tool-image:read', args, '')).status).toBe(401)
    const read = await (await rpc('tool-image:read', args)).json()
    expect(read.result.data).toBe(PNG)
    expect((await rpc('tool-image:copy', [...args, PNG])).status).toBe(404)
    expect(clipboardWrite).not.toHaveBeenCalled()
  })
  it('uses the client browser transport and refuses server-side clipboard calls', async () => {
    vi.stubGlobal('location', new URL('https://example.test/c/aaaaaaaaaaaaaaaa/'))
    vi.stubGlobal('localStorage', { getItem: () => 'token' })
    vi.stubGlobal('EventSource', class {})
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, result: null }) })
    vi.stubGlobal('fetch', fetchMock)
    const api = createWebApi()
    await api.prepareToolImages('t', 'i'); await api.readToolImage('t', 'i', 'image')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://example.test/c/aaaaaaaaaaaaaaaa/api/rpc/tool-image%3Alist','https://example.test/c/aaaaaaaaaaaaaaaa/api/rpc/tool-image%3Aread'])
    for (const [, options] of fetchMock.mock.calls) expect(options.headers['x-token']).toBe('token')
    await expect(api.copyToolImage('t', 'i', 'image', PNG)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
