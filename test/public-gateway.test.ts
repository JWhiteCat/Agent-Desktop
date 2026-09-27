import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ID_A = 'aaaaaaaaaaaaaaaa'
const ID_B = 'bbbbbbbbbbbbbbbb'
const gatewayPath = fileURLToPath(new URL('../scripts/public-gateway.py', import.meta.url))

function pythonCommand(): { cmd: string; prefix: string[] } | undefined {
  const candidates = process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']]
  for (const parts of candidates) {
    const result = spawnSync(parts[0], [...parts.slice(1), '--version'], { encoding: 'utf8', windowsHide: true })
    if (result.status === 0) return { cmd: parts[0], prefix: parts.slice(1) }
  }
  return undefined
}

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      resolve({ server, port: address.port })
    })
  })
}

function waitForPort(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(buf || '公网入口没有打印端口')), 8000)
    const onExit = (code: number | null) => {
      clearTimeout(timer)
      reject(new Error(`公网入口退出 ${code ?? 'unknown'}：${buf}`))
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      buf += chunk
    })
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk
      const match = /PORT (\d+)/.exec(buf)
      if (!match) return
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(Number(match[1]))
    })
    child.once('exit', onExit)
  })
}

describe('public gateway', () => {
  const python = pythonCommand()
  const children: ChildProcess[] = []
  const servers: http.Server[] = []

  afterEach(async () => {
    for (const child of children) child.kill()
    children.length = 0
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it.skipIf(!python)('routes one port to the computer named in the link', async () => {
    const first = await listen((req, res) => {
      if (req.url === '/api/public-health') return res.end(JSON.stringify({ ok: true, clientId: ID_A }))
      if (req.url === '/saw-prefix') return res.end(String(req.headers['x-agent-desktop-prefix'] ?? ''))
      if (req.method === 'POST') {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => res.end(Buffer.concat(chunks)))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: from-a\n\n')
      res.end()
    })
    const second = await listen((_req, res) => {
      res.end('from-b')
    })
    servers.push(first.server, second.server)

    const child = spawn(python!.cmd, [...python!.prefix, gatewayPath, '--port', '0', '--socket-dir', os.tmpdir()], {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        AGENT_DESKTOP_GATEWAY_TEST: '1',
        AGENT_DESKTOP_GATEWAY_MAP: `${ID_A}=127.0.0.1:${first.port},${ID_B}=127.0.0.1:${second.port}`
      }
    })
    children.push(child)
    const port = await waitForPort(child)
    const origin = `http://127.0.0.1:${port}`

    expect(await (await fetch(`${origin}/c/${ID_A}/api/public-health`)).json()).toEqual({ ok: true, clientId: ID_A })
    expect(await (await fetch(`${origin}/c/${ID_B}/`)).text()).toBe('from-b')
    expect(await (await fetch(`${origin}/c/${ID_A}/saw-prefix`)).text()).toBe(`/c/${ID_A}`)

    const posted = await fetch(`${origin}/c/${ID_A}/api/rpc/echo`, { method: 'POST', body: '[1,2]' })
    expect(await posted.text()).toBe('[1,2]')

    const events = await fetch(`${origin}/c/${ID_A}/api/events`)
    expect(await events.text()).toContain('data: from-a')

    const redirect = await fetch(`${origin}/c/${ID_A}?token=abc`, { redirect: 'manual' })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe(`/c/${ID_A}/?token=abc`)

    expect((await fetch(`${origin}/`)).status).toBe(404)
    expect((await fetch(`${origin}/c/cccccccccccccccc/`)).status).toBe(502)
  })
})
