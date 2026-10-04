import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ID_A = 'aaaaaaaaaaaaaaaa'
const ID_B = 'bbbbbbbbbbbbbbbb'
const gatewayPath = fileURLToPath(new URL('../scripts/public-gateway.py', import.meta.url))
const children: ChildProcess[] = []
const servers: http.Server[] = []
const directories: string[] = []

function pythonCommand(): { cmd: string; prefix: string[] } | undefined {
  const candidates = process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']]
  for (const parts of candidates) {
    const result = spawnSync(parts[0], [...parts.slice(1), '--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    if (result.status === 0) return { cmd: parts[0], prefix: parts.slice(1) }
  }
  return undefined
}

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler)
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('no port'))
      resolve({ server, port: address.port })
    })
  })
}

function waitForPort(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => finish(new Error(buf || '公网入口没有打印端口')), 5000)
    const finish = (error?: Error, port?: number) => {
      clearTimeout(timer)
      child.off('error', onError)
      child.off('exit', onExit)
      child.stdout?.off('data', onData)
      // Keep draining stderr so diagnostics cannot fill the pipe during requests.
      if (error) reject(error)
      else resolve(port!)
    }
    const onError = (error: Error) => finish(error)
    const onExit = (code: number | null) => finish(new Error(`公网入口退出 ${code ?? 'unknown'}：${buf}`))
    const onData = (chunk: string) => {
      buf += chunk
      const match = /PORT (\d+)/.exec(buf)
      if (match) finish(undefined, Number(match[1]))
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { buf += chunk })
    child.stdout?.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

// Bound I/O even if a regression never sends headers or closes a stream.
const request = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) })

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let frame = ''
  while (!frame.endsWith('\n\n')) {
    const chunk = await reader.read()
    expect(chunk.done, 'SSE ended before a complete event arrived').toBe(false)
    frame += decoder.decode(chunk.value, { stream: true })
  }
  return frame
}

describe('public gateway', () => {
  const python = pythonCommand()

  async function gateway(mapping: string): Promise<string> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-gateway-'))
    directories.push(directory)
    // The gateway chmods its socket directory; never pass the shared system temp directory.
    const child = spawn(python!.cmd, [...python!.prefix, gatewayPath, '--port', '0', '--socket-dir', path.join(directory, 'sockets')], {
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        AGENT_DESKTOP_GATEWAY_TEST: '1',
        AGENT_DESKTOP_GATEWAY_MAP: mapping
      }
    })
    children.push(child)
    return `http://127.0.0.1:${await waitForPort(child)}`
  }

  afterEach(async () => {
    await Promise.all(children.splice(0).map(stopChild))
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })))
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
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
      res.end('from-a')
    })
    const second = await listen((_req, res) => { res.end('from-b') })
    const origin = await gateway(`${ID_A}=127.0.0.1:${first.port},${ID_B}=127.0.0.1:${second.port}`)

    expect(await (await request(`${origin}/c/${ID_A}/api/public-health`)).json()).toEqual({ ok: true, clientId: ID_A })
    expect(await (await request(`${origin}/c/${ID_B}/`)).text()).toBe('from-b')
    expect(await (await request(`${origin}/c/${ID_A}/saw-prefix`)).text()).toBe(`/c/${ID_A}`)

    const posted = await request(`${origin}/c/${ID_A}/api/rpc/echo`, { method: 'POST', body: '[1,2]' })
    expect(await posted.text()).toBe('[1,2]')

    const redirect = await request(`${origin}/c/${ID_A}?token=abc`, { redirect: 'manual' })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe(`/c/${ID_A}/?token=abc`)
    await redirect.arrayBuffer()
    for (const [route, status] of [['/', 404], ['/c/cccccccccccccccc/', 502]] as const) {
      const response = await request(`${origin}${route}`)
      expect(response.status).toBe(status)
      await response.arrayBuffer()
    }
  }, 15_000)

  it.skipIf(!python)('forwards each SSE event while the upstream stream remains open', async () => {
    let upstream!: http.ServerResponse
    const source = await listen((_req, res) => {
      upstream = res
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
    })
    const origin = await gateway(`${ID_A}=127.0.0.1:${source.port}`)
    const events = await request(`${origin}/c/${ID_A}/api/events`)
    expect(events.status).toBe(200)
    expect(events.headers.get('content-type')).toBe('text/event-stream')
    const reader = events.body!.getReader()
    try {
      expect(await readFrame(reader)).toBe('data: first\n\n')
      expect(upstream.writableEnded).toBe(false)
      upstream.write('data: second\n\n')
      expect(await readFrame(reader)).toBe('data: second\n\n')
      expect(upstream.writableEnded).toBe(false)
      upstream.end()
      expect((await reader.read()).done).toBe(true)
    } finally {
      await reader.cancel()
    }
  }, 15_000)
})
