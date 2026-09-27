import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RemoteServer, rewriteDevAbsolutePaths } from '../src/main/remote'

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
