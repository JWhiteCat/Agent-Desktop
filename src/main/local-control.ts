import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AppState } from '@shared/types'
import { isProcessAlive } from './headless-lock'
import { pathKey, writeTextSafely } from './local-files'
import type { Handler } from './remote'
import { remoteSafeState } from './remote-runtime'

export const LOCAL_CONTROL_FILE = 'cli-control.json'
const MAX_BODY = 20 * 1024 * 1024
const HEARTBEAT_MS = 15_000
const HEARTBEAT_FRAME = `data: ${JSON.stringify({ channel: 'transport:ping', payload: null })}\n\n`

export interface LocalControlMeta {
  version: 1
  pid: number
  socketPath: string
  token: string
  appVersion: string
  startedAt: number
}

export interface LocalControlHealth {
  ok: true
  pid: number
  appVersion: string
  startedAt: number
}

export function localControlFilePath(dataDir: string): string {
  return path.join(dataDir, LOCAL_CONTROL_FILE)
}

/** Removes `cli-control.json` and (on POSIX) the Unix socket only when this instance still owns `cli-control.json`. */
export function cleanupLocalControlFiles(
  dataDir: string,
  meta: LocalControlMeta,
  platform: NodeJS.Platform = process.platform
): void {
  const current = readLocalControlMeta(dataDir)
  if (!current || current.pid !== meta.pid || current.token !== meta.token) return
  try {
    fs.rmSync(localControlFilePath(dataDir), { force: true })
  } catch {
    // ignore
  }
  if (platform !== 'win32') {
    try {
      fs.rmSync(meta.socketPath, { force: true })
    } catch {
      // ignore
    }
  }
}

export function localControlSocketPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const hash = crypto.createHash('sha256').update(pathKey(path.resolve(dataDir))).digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\agent-desktop-cli-${hash}`
  }
  return path.join(path.resolve(dataDir), 'cli-ipc.sock')
}

export function readLocalControlMeta(dataDir: string): LocalControlMeta | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(localControlFilePath(dataDir), 'utf8')) as Partial<LocalControlMeta>
    if (
      parsed.version !== 1
      || typeof parsed.pid !== 'number'
      || typeof parsed.socketPath !== 'string'
      || !parsed.socketPath
      || typeof parsed.token !== 'string'
      || !parsed.token
    ) return undefined
    return {
      version: 1,
      pid: parsed.pid,
      socketPath: parsed.socketPath,
      token: parsed.token,
      appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : '0.0.0',
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0
    }
  } catch {
    return undefined
  }
}

export function probeLocalControl(meta: LocalControlMeta, timeoutMs = 500): Promise<LocalControlHealth | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: LocalControlHealth | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = http.request({
      socketPath: meta.socketPath,
      path: '/api/health',
      method: 'GET',
      headers: { 'x-token': meta.token },
      timeout: timeoutMs
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(undefined)
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<LocalControlHealth>
          if (body.ok === true && typeof body.pid === 'number') {
            return finish({
              ok: true,
              pid: body.pid,
              appVersion: typeof body.appVersion === 'string' ? body.appVersion : meta.appVersion,
              startedAt: typeof body.startedAt === 'number' ? body.startedAt : meta.startedAt
            })
          }
        } catch {
          // invalid JSON
        }
        finish(undefined)
      })
    })
    req.on('timeout', () => {
      req.destroy()
      finish(undefined)
    })
    req.on('error', () => finish(undefined))
    req.end()
  })
}

const LOCAL_CLI_ALLOWED = new Set([
  'state:get',
  'project:add',
  'project:update',
  'project:remove',
  'project:reorder',
  'project:collapseAll',
  'thread:create',
  'thread:update',
  'thread:delete',
  'thread:items',
  'thread:fork',
  'thread:syncFromCli',
  'agent:send',
  'agent:prepare',
  'agent:stop',
  'agent:queueRemove',
  'agent:queueReorder',
  'agent:queueSendNow',
  'agent:answerQuestion',
  'attachment:upload',
  'attachment:read',
  'cli:models',
  'cli:info',
  'cli:installStatus',
  'cli:scan',
  'cli:import',
  'git:diff',
  'usage:summary',
  'usage:quotas',
  'usage:quota',
  'remote:info'
])

/** Exposes only safe, non-dialog RPC handlers for local CLI clients and scrubs secrets from state snapshots. */
export function handlersForLocalCli(handlers: Record<string, Handler>, snapshot: () => AppState): Record<string, Handler> {
  const out: Record<string, Handler> = {}
  for (const [name, fn] of Object.entries(handlers)) {
    if (LOCAL_CLI_ALLOWED.has(name)) out[name] = fn
  }
  out['state:get'] = () => remoteSafeState(snapshot())
  return out
}

function sameToken(given: string | undefined, expected: string): boolean {
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
        reject(new Error('Request body too large'))
        req.destroy()
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export interface LocalControlOptions {
  dataDir: string
  appVersion: string
  handlers: Record<string, Handler>
  socketPath?: string
}

/**
 * Local-only HTTP-over-IPC (Unix socket / Windows Named Pipe) server started by the desktop main process.
 * Allows `agent-desktop` / `agd` CLI invocations to control the running desktop instance with live UI sync.
 */
export class LocalControlServer {
  private server: http.Server | undefined
  private clients = new Set<http.ServerResponse>()
  private heartbeat: NodeJS.Timeout | undefined
  private meta: LocalControlMeta | undefined
  private dataDir: string | undefined

  get running(): boolean {
    return !!this.server?.listening
  }

  get info(): LocalControlMeta | undefined {
    return this.meta
  }

  async start(opts: LocalControlOptions): Promise<LocalControlMeta | undefined> {
    await this.stop()
    fs.mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 })

    // If another desktop window already owns the control endpoint for this dataDir, do not clobber it.
    const existing = readLocalControlMeta(opts.dataDir)
    if (existing && existing.pid !== process.pid) {
      if (isProcessAlive(existing.pid)) {
        const alive = await probeLocalControl(existing, 400)
        if (alive) return undefined
      }
    }

    const socketPath = opts.socketPath ?? localControlSocketPath(opts.dataDir)
    if (process.platform !== 'win32') {
      try {
        fs.rmSync(socketPath, { force: true })
      } catch {
        // ignore stale socket cleanup errors
      }
    }

    const token = crypto.randomBytes(32).toString('hex')
    const meta: LocalControlMeta = {
      version: 1,
      pid: process.pid,
      socketPath,
      token,
      appVersion: opts.appVersion,
      startedAt: Date.now()
    }

    const server = http.createServer((req, res) => {
      this.handle(req, res, opts.handlers, meta, server).catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        else res.end()
      })
    })

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(socketPath, 0o600)
        } catch {
          // ignore chmod failures on restricted filesystems
        }
      }
    } catch (err) {
      try {
        server.close()
      } catch {
        // ignore
      }
      throw err
    }

    this.server = server
    this.meta = meta
    this.dataDir = opts.dataDir
    writeTextSafely(localControlFilePath(opts.dataDir), JSON.stringify(meta, null, 2), false)
    this.heartbeat = setInterval(() => {
      this.writeSse(HEARTBEAT_FRAME)
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
    return meta
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    for (const c of [...this.clients]) {
      try {
        c.end()
      } catch {
        // ignore
      }
    }
    this.clients.clear()

    const server = this.server
    const meta = this.meta
    const dataDir = this.dataDir
    this.server = undefined
    this.meta = undefined
    this.dataDir = undefined

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    }

    if (dataDir && meta) {
      cleanupLocalControlFiles(dataDir, meta)
    }
  }

  broadcast(channel: string, payload: unknown): void {
    if (!this.clients.size) return
    const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`
    this.writeSse(frame)
  }

  private writeSse(frame: string): void {
    for (const c of [...this.clients]) {
      if (c.destroyed || c.writableEnded) {
        this.clients.delete(c)
        continue
      }
      try {
        c.write(frame)
      } catch {
        this.clients.delete(c)
        try {
          c.destroy()
        } catch {
          // ignore
        }
      }
    }
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handlers: Record<string, Handler>,
    meta: LocalControlMeta,
    server: http.Server
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const token = req.headers['x-token'] as string | undefined
    if (!sameToken(token, meta.token)) {
      return sendJson(res, 401, { ok: false, error: 'Invalid local control token' })
    }

    if (url.pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        pid: meta.pid,
        appVersion: meta.appVersion,
        startedAt: meta.startedAt
      } satisfies LocalControlHealth)
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive'
      })
      res.write(': connected\n\n')
      this.clients.add(res)
      const remove = () => this.clients.delete(res)
      res.on('error', remove)
      res.on('close', remove)
      req.on('close', remove)
      return
    }

    const rpc = /^\/api\/rpc\/(.+)$/.exec(url.pathname)
    if (rpc && req.method === 'POST') {
      const name = decodeURIComponent(rpc[1])
      const fn = Object.hasOwn(handlers, name) ? handlers[name] : undefined
      if (!fn) return sendJson(res, 404, { ok: false, error: `Unsupported CLI RPC channel: ${name}` })
      let args: unknown[]
      try {
        const body = await readBody(req)
        args = body ? JSON.parse(body) : []
        if (!Array.isArray(args)) throw new Error('RPC arguments must be an array')
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      if (this.server !== server || res.destroyed) return
      try {
        const result = await fn(...args)
        if (!res.destroyed) sendJson(res, 200, { ok: true, result })
      } catch (err) {
        if (!res.destroyed) sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    sendJson(res, 404, { ok: false, error: 'Not found' })
  }
}
