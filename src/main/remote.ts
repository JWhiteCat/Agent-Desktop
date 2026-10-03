import { t as translate } from '@shared/i18n'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

export type Handler = (...args: any[]) => unknown

export interface RemoteServerOptions {
  port: number
  token: string
  /** Stable public-link id. Returned by the unauthenticated health check. */
  clientId: string
  /** RPC channels reachable from the browser, keyed like the IPC channels. */
  handlers: Record<string, Handler>
  /** Built renderer (`out/renderer`). */
  staticDir?: string
  /** Vite dev server; used instead of `staticDir` when set. */
  devUrl?: string
}

const MAX_BODY = 20 * 1024 * 1024
const HEARTBEAT_MS = 25_000
const PUBLIC_PREFIX = /^\/c\/[a-f0-9]{16}$/

export function publicPrefixHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw || !PUBLIC_PREFIX.test(raw)) return undefined
  return raw
}

/** Vite dev URLs are root-absolute. Under `/c/<id>/` they must keep that prefix so the gateway can route them. */
export function rewriteDevAbsolutePaths(body: string, prefix: string): string {
  const base = prefix.replace(/\/$/, '')
  return body.replace(/(^|[\s"'`(:=])\/(?=@|src\/|node_modules\/)/g, `$1${base}/`)
}

/**
 * Dev-mode page requests are forwarded to Vite. The request target must stay on that origin:
 * an absolute-form or protocol-relative URL would otherwise turn the open remote port into a proxy.
 */
export function resolveDevProxyUrl(requestUrl: string, devUrl: string): URL | undefined {
  let base: URL
  let target: URL
  try {
    base = new URL(devUrl)
    target = new URL(requestUrl || '/', base)
  } catch {
    return undefined
  }
  if (target.origin !== base.origin) return undefined
  return target
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

export function newRemoteToken(): string {
  return crypto.randomBytes(16).toString('hex')
}

const VIRTUAL_NIC = /vethernet|vmware|virtualbox|docker|wsl|hyper-v|loopback|tailscale|zerotier|utun|bridge/i

/** LAN IPv4 addresses, likely Wi-Fi/Ethernet first. */
export function lanAddresses(): string[] {
  const found: { ip: string; rank: number }[] = []
  let interfaces: ReturnType<typeof os.networkInterfaces>
  try {
    interfaces = os.networkInterfaces()
  } catch {
    // Restricted Linux desktops/containers may deny interface enumeration. LAN
    // discovery is optional and must not prevent settings or the desktop loading.
    return []
  }
  for (const [name, list] of Object.entries(interfaces)) {
    for (const nic of list ?? []) {
      if (nic.internal || (nic.family !== 'IPv4' && (nic.family as unknown) !== 4)) continue
      if (nic.address.startsWith('169.254.')) continue
      const privateNet = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(nic.address)
      found.push({ ip: nic.address, rank: (VIRTUAL_NIC.test(name) ? 2 : 0) + (privateNet ? 0 : 1) })
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((x) => x.ip)
}

function sameToken(given: string | undefined | null, expected: string): boolean {
  if (!given || !expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error(translate('请求体过大')))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export class RemoteServer {
  private server: http.Server | undefined
  private clients = new Set<http.ServerResponse>()
  private heartbeat: NodeJS.Timeout | undefined
  private lifecycle: Promise<void> = Promise.resolve()

  get running(): boolean {
    return !!this.server?.listening
  }

  get port(): number | undefined {
    const addr = this.server?.address()
    return addr && typeof addr === 'object' ? addr.port : undefined
  }

  start(opts: RemoteServerOptions): Promise<void> {
    return this.enqueue(() => this.startServer(opts))
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.stopServer())
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.lifecycle.then(operation)
    // A failed bind must not prevent a later stop or restart.
    this.lifecycle = pending.catch(() => {})
    return pending
  }

  private async startServer(opts: RemoteServerOptions): Promise<void> {
    await this.stopServer()
    const server = http.createServer((req, res) => {
      this.handle(req, res, opts, server).catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) })
        else res.end()
      })
    })
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(opts.port, '0.0.0.0', () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (err) {
      await this.stopServer()
      throw err
    }
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.write(': ping\n\n')
    }, HEARTBEAT_MS)
  }

  private async stopServer(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    for (const c of this.clients) c.end()
    this.clients.clear()
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  broadcast(channel: string, payload: unknown): void {
    if (!this.clients.size) return
    const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`
    for (const c of this.clients) c.write(frame)
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, opts: RemoteServerOptions, server: http.Server): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/public-health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, clientId: opts.clientId })
    }
    if (!url.pathname.startsWith('/api/')) return this.serveStatic(req, res, url, opts)

    const token = (req.headers['x-token'] as string | undefined) ?? url.searchParams.get('token')
    if (!sameToken(token, opts.token)) return sendJson(res, 401, { ok: false, error: translate('远程访问令牌无效，请重新扫描二维码') })

    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      })
      res.write(': connected\n\n')
      this.clients.add(res)
      req.on('close', () => this.clients.delete(res))
      return
    }

    const rpc = /^\/api\/rpc\/(.+)$/.exec(url.pathname)
    if (rpc && req.method === 'POST') {
      const name = decodeURIComponent(rpc[1])
      const fn = Object.hasOwn(opts.handlers, name) ? opts.handlers[name] : undefined
      if (!fn) return sendJson(res, 404, { ok: false, error: translate('远程端不支持：{name}', { name }) })
      let args: unknown[]
      try {
        const body = await readBody(req)
        args = body ? JSON.parse(body) : []
        if (!Array.isArray(args)) throw new Error(translate('参数必须是数组'))
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      // A request whose body finished during shutdown cannot start another task.
      if (this.server !== server || res.destroyed) return
      try {
        const result = await fn(...args)
        return sendJson(res, 200, { ok: true, result: result ?? null })
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    }

    sendJson(res, 404, { ok: false, error: 'Not found' })
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL, opts: RemoteServerOptions): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    if (opts.devUrl) return this.proxy(req, res, opts.devUrl)
    if (!opts.staticDir) {
      res.writeHead(404).end()
      return
    }
    const root = path.resolve(opts.staticDir)
    let file = path.resolve(root, '.' + decodeURIComponent(url.pathname))
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end()
      return
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    if (!fs.existsSync(file)) {
      res.writeHead(404).end()
      return
    }
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
    })
    if (req.method === 'HEAD') res.end()
    else fs.createReadStream(file).pipe(res)
  }

  private proxy(req: http.IncomingMessage, res: http.ServerResponse, devUrl: string): void {
    const prefix = publicPrefixHeader(req.headers['x-agent-desktop-prefix'])
    const target = resolveDevProxyUrl(req.url ?? '/', devUrl)
    if (!target) {
      req.resume()
      res.writeHead(403).end()
      return
    }
    const upstream = http.request(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host } },
      (up) => {
        const type = String(up.headers['content-type'] ?? '')
        const rewrite = !!prefix && /text\/html|javascript|text\/css/.test(type) && !up.headers['content-encoding']
        if (!rewrite) {
          res.writeHead(up.statusCode ?? 502, up.headers)
          up.pipe(res)
          return
        }
        const chunks: Buffer[] = []
        up.on('data', (chunk: Buffer) => chunks.push(chunk))
        up.on('end', () => {
          const body = Buffer.from(rewriteDevAbsolutePaths(Buffer.concat(chunks).toString('utf8'), prefix))
          const headers = { ...up.headers }
          delete headers['transfer-encoding']
          headers['content-length'] = String(body.length)
          res.writeHead(up.statusCode ?? 502, headers)
          res.end(body)
        })
      }
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  }
}
