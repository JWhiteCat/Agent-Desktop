import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentStore } from '../src/main/attachments'
import { RemoteServer } from '../src/main/remote'
import { handlersForRemote } from '../src/main/remote-runtime'
import { createWebApi } from '../src/renderer/src/lib/web-api'
import { DEFAULT_SETTINGS } from '../src/shared/types'

describe('attachment remote transport', () => {
  let dir: string
  let server: RemoteServer
  let base: string
  const token = 'attachment-test-token'

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-attachment-remote-'))
    const storage = new AttachmentStore({ dataDir: dir, threads: [], items: () => [] })
    const state = { projects: [], threads: [], running: [], settings: DEFAULT_SETTINGS }
    server = new RemoteServer()
    await server.start({ port: 0, token, clientId: 'aaaaaaaaaaaaaaaa', handlers: handlersForRemote({
      'attachment:upload': (req) => storage.upload(req),
      'attachment:read': (id) => storage.read(id),
      'attachment:open': () => 'should not run'
    }, () => state) })
    base = `http://127.0.0.1:${server.port}`
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await server.stop()
    const resolved = path.resolve(dir)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-attachment-remote-')) throw new Error('Unexpected test directory')
    fs.rmSync(resolved, { recursive: true, force: true })
  })

  const rpc = (name: string, args: unknown[], auth = token) => fetch(`${base}/api/rpc/${name}`, {
    method: 'POST', headers: { 'x-token': auth, 'content-type': 'application/json' }, body: JSON.stringify(args)
  })

  it('roundtrips exact binary bytes and requires authentication for both directions', async () => {
    const req = { name: '测试.bin', mimeType: 'application/octet-stream', data: Buffer.from([0, 255, 1, 254]).toString('base64') }
    expect((await rpc('attachment:upload', [req], '')).status).toBe(401)
    const uploaded = await (await rpc('attachment:upload', [req])).json()
    expect(uploaded.ok).toBe(true)
    expect((await rpc('attachment:read', [uploaded.result.id], '')).status).toBe(401)
    expect(await (await rpc('attachment:read', [uploaded.result.id])).json()).toEqual({ ok: true, result: { data: req.data, mimeType: req.mimeType } })
    expect((await rpc('attachment:open', [uploaded.result.id])).status).toBe(404)
    expect((await (await rpc('attachment:read', ['../state.json'])).json()).ok).toBe(false)
  })

  it('fits a maximum-sized individual file inside the existing RPC body limit', async () => {
    const req = { name: 'maximum.bin', mimeType: '', data: Buffer.alloc(10 * 1024 * 1024).toString('base64') }
    const response = await rpc('attachment:upload', [req])
    expect(response.status).toBe(200)
    expect((await response.json()).result.size).toBe(10 * 1024 * 1024)
  })

  it('keeps attachment browser calls authenticated under the public prefix', async () => {
    vi.stubGlobal('location', new URL('https://example.test/c/aaaaaaaaaaaaaaaa/'))
    vi.stubGlobal('localStorage', { getItem: () => token })
    vi.stubGlobal('EventSource', class {})
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, result: null }) })
    vi.stubGlobal('fetch', fetchMock)
    const api = createWebApi()
    await api.uploadAttachment({ name: 'one.txt', mimeType: 'text/plain', data: 'YQ==' })
    await api.readAttachment('file-id')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://example.test/c/aaaaaaaaaaaaaaaa/api/rpc/attachment%3Aupload',
      'https://example.test/c/aaaaaaaaaaaaaaaa/api/rpc/attachment%3Aread'
    ])
    for (const [, options] of fetchMock.mock.calls) expect(options.headers['x-token']).toBe(token)
    await expect(api.openAttachment('file-id')).rejects.toThrow()
  })
})
