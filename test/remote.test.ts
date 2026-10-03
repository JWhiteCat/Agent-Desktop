import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteServer, resolveDevProxyUrl, rewriteDevAbsolutePaths } from '../src/main/remote'

const TOKEN = 'secret-token'

describe('RemoteServer', () => {
  let server: RemoteServer
  let base: string
  let staticDir: string

  beforeEach(async () => {
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-test-'))
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<html>app</html>')
    server = new RemoteServer()
    await server.start({
      port: 0,
      token: TOKEN,
      clientId: 'aaaaaaaaaaaaaaaa',
      staticDir,
      handlers: {
        echo: (a: number, b: number) => a + b,
        fail: () => {
          throw new Error('boom')
        }
      }
    })
    base = `http://127.0.0.1:${server.port}`
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(staticDir, { recursive: true, force: true })
  })

  const rpc = (name: string, args: unknown[], token = TOKEN) =>
    fetch(`${base}/api/rpc/${name}`, { method: 'POST', headers: { 'x-token': token }, body: JSON.stringify(args) })

  it('reports this computer on the public health check without a token', async () => {
    const res = await fetch(`${base}/api/public-health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, clientId: 'aaaaaaaaaaaaaaaa' })
  })

  it('rewrites Vite dev paths so they stay under the public prefix', () => {
    const body = `<script src="/src/main.tsx"></script>\nimport "/@vite/client"\nimport "/src/App.tsx"`
    expect(rewriteDevAbsolutePaths(body, '/c/aaaaaaaaaaaaaaaa')).toBe(
      `<script src="/c/aaaaaaaaaaaaaaaa/src/main.tsx"></script>\nimport "/c/aaaaaaaaaaaaaaaa/@vite/client"\nimport "/c/aaaaaaaaaaaaaaaa/src/App.tsx"`
    )
  })

  it('serves the app without a token and falls back to index.html', async () => {
    const res = await fetch(`${base}/some/route`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('app')
  })

  it('rejects API calls with a missing or wrong token', async () => {
    expect((await fetch(`${base}/api/rpc/echo`, { method: 'POST', body: '[1,2]' })).status).toBe(401)
    expect((await rpc('echo', [1, 2], 'wrong')).status).toBe(401)
  })

  it('calls handlers and reports errors', async () => {
    expect(await (await rpc('echo', [1, 2])).json()).toEqual({ ok: true, result: 3 })
    expect(await (await rpc('fail', [])).json()).toEqual({ ok: false, error: 'boom' })
    expect((await rpc('project:pick', [])).status).toBe(404)
    expect((await rpc('toString', [])).status).toBe(404)
  })

  it('pushes broadcasts over SSE', async () => {
    const res = await fetch(`${base}/api/events?token=${TOKEN}`)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = decoder.decode((await reader.read()).value)
    server.broadcast('state:changed', { n: 1 })
    while (!text.includes('data:')) text += decoder.decode((await reader.read()).value)
    expect(text).toContain(JSON.stringify({ channel: 'state:changed', payload: { n: 1 } }))
    await reader.cancel()
  })
})

describe('remote server lifecycle', () => {
  let remote: RemoteServer
  let created: ReturnType<typeof vi.spyOn<typeof http, 'createServer'>>
  const options = { port: 0, token: TOKEN, clientId: 'aaaaaaaaaaaaaaaa', handlers: { echo: () => 'ok' } }

  beforeEach(() => {
    remote = new RemoteServer()
    created = vi.spyOn(http, 'createServer')
  })

  afterEach(async () => {
    await remote.stop()
    // Clean up every listener even if a regression loses the active-server reference.
    const servers = created.mock.results.flatMap((result) => result.type === 'return' ? [result.value as http.Server] : [])
    created.mockRestore()
    for (const server of servers) await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  })

  it('closes every listener when simultaneous starts are followed by stop', async () => {
    await Promise.all([remote.start(options), remote.start(options)])
    const servers = created.mock.results.map((result) => result.value as http.Server)
    expect(servers.filter((server) => server.listening)).toHaveLength(1)
    await remote.stop()
    expect(remote.running).toBe(false)
    expect(servers.every((server) => !server.listening)).toBe(true)
  })

  it('does not leave a pending start running after stop resolves', async () => {
    await Promise.all([remote.start(options), remote.stop()])
    expect(remote.running).toBe(false)
    expect(created.mock.results.every((result) => !(result.value as http.Server).listening)).toBe(true)
  })

  it('disconnects old event streams and rejects previous tokens after overlapping restarts', async () => {
    await remote.start(options)
    const events = await fetch(`http://127.0.0.1:${remote.port}/api/events?token=${TOKEN}`)
    const reader = events.body!.getReader()
    await reader.read()
    const disconnected = reader.read().then((chunk) => chunk.done, () => true)
    await Promise.all([
      remote.start({ ...options, token: 'intermediate-token' }),
      remote.start({ ...options, token: 'new-token' })
    ])
    expect(await disconnected).toBe(true)
    for (const [token, status] of [[TOKEN, 401], ['intermediate-token', 401], ['new-token', 200]] as const) {
      const response = await fetch(`http://127.0.0.1:${remote.port}/api/rpc/echo`, { method: 'POST', headers: { 'x-token': token }, body: '[]' })
      expect(response.status).toBe(status)
      await response.arrayBuffer()
    }
  })

  it('cleans up a failed restart and allows another start afterwards', async () => {
    const occupied = http.createServer()
    await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve))
    await remote.start(options)
    await expect(remote.start({ ...options, port: (occupied.address() as { port: number }).port })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(remote.running).toBe(false)
    await remote.start(options)
    expect(remote.running).toBe(true)
    await remote.stop()
    expect(created.mock.results.every((result) => result.value === occupied || !(result.value as http.Server).listening)).toBe(true)
  })
})

describe('dev proxy target', () => {
  const devUrl = 'http://127.0.0.1:5173/'

  it('keeps ordinary page paths on the Vite origin', () => {
    expect(resolveDevProxyUrl('/src/main.tsx', devUrl)?.href).toBe('http://127.0.0.1:5173/src/main.tsx')
    expect(resolveDevProxyUrl('http://127.0.0.1:5173/src/main.tsx', devUrl)?.href).toBe('http://127.0.0.1:5173/src/main.tsx')
  })

  it('rejects absolute-form and protocol-relative targets', () => {
    expect(resolveDevProxyUrl('http://169.254.169.254/latest/meta-data/', devUrl)).toBeUndefined()
    expect(resolveDevProxyUrl('//evil.example/steal', devUrl)).toBeUndefined()
    expect(resolveDevProxyUrl('http://127.0.0.1:9/secret', devUrl)).toBeUndefined()
  })
})

describe('dev proxy server', () => {
  let vite: http.Server
  let bait: http.Server
  let remote: RemoteServer
  let vitePort: number
  let baitHits = 0

  beforeEach(async () => {
    baitHits = 0
    vite = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('from-vite')
    })
    bait = http.createServer((_req, res) => {
      baitHits += 1
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('from-bait')
    })
    await new Promise<void>((resolve) => vite.listen(0, '127.0.0.1', () => resolve()))
    await new Promise<void>((resolve) => bait.listen(0, '127.0.0.1', () => resolve()))
    vitePort = (vite.address() as { port: number }).port
    remote = new RemoteServer()
    await remote.start({
      port: 0,
      token: TOKEN,
      clientId: 'aaaaaaaaaaaaaaaa',
      devUrl: `http://127.0.0.1:${vitePort}`,
      handlers: {}
    })
  })

  afterEach(async () => {
    await remote.stop()
    await Promise.all([vite, bait].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  function request(target: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: remote.port, path: target, method: 'GET' }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('forwards page requests to Vite and refuses other hosts', async () => {
    const baitPort = (bait.address() as { port: number }).port
    const page = await request('/src/main.tsx')
    expect(page).toEqual({ status: 200, body: 'from-vite' })

    const absolute = await request(`http://127.0.0.1:${baitPort}/steal`)
    const relative = await request('//evil.example/steal')
    expect(absolute.status).toBe(403)
    expect(relative.status).toBe(403)
    expect(baitHits).toBe(0)
  })
})
