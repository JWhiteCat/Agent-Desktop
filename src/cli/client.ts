import fs from 'node:fs'
import http from 'node:http'
import type { AgentEvent, AppState } from '@shared/types'
import { isProcessAlive } from '../main/headless-lock'
import {
  localControlFilePath,
  probeLocalControl,
  readLocalControlMeta,
  type LocalControlHealth,
  type LocalControlMeta
} from '../main/local-control'
import { CliError, EXIT_ERROR, type CliRuntime } from './types'

export class AttachedCliRuntime implements CliRuntime {
  readonly mode = 'attached' as const
  readonly dataDir: string
  readonly desktopPid: number
  readonly appVersion: string
  private readonly meta: LocalControlMeta
  private readonly activeStreams = new Set<http.ClientRequest>()

  constructor(dataDir: string, meta: LocalControlMeta, health: LocalControlHealth) {
    this.dataDir = dataDir
    this.meta = meta
    this.desktopPid = health.pid
    this.appVersion = health.appVersion
  }

  call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const body = JSON.stringify(args)
      const req = http.request({
        socketPath: this.meta.socketPath,
        path: `/api/rpc/${encodeURIComponent(channel)}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'x-token': this.meta.token
        }
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            const parsed = JSON.parse(text) as { ok?: boolean; result?: T; error?: string }
            if (res.statusCode === 200 && parsed.ok) return resolve(parsed.result as T)
            reject(new CliError(parsed.error || `RPC ${channel} failed (HTTP ${res.statusCode})`, EXIT_ERROR))
          } catch {
            reject(new CliError(`RPC ${channel} returned invalid JSON (HTTP ${res.statusCode})`, EXIT_ERROR))
          }
        })
      })
      req.on('error', (err) => reject(new CliError(`Failed to reach desktop instance: ${err.message}`, EXIT_ERROR)))
      req.end(body)
    })
  }

  subscribe(listeners: {
    onEvent?: (event: AgentEvent) => void
    onState?: (state: AppState) => void
    onDisconnect?: (err?: Error) => void
  }): Promise<() => void> {
    return new Promise((resolve, reject) => {
      let opened = false
      let closed = false
      let buffer = ''

      const req = http.request({
        socketPath: this.meta.socketPath,
        path: '/api/events',
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          'x-token': this.meta.token
        }
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          const err = new CliError(`Failed to subscribe to desktop events (HTTP ${res.statusCode})`, EXIT_ERROR)
          if (!opened) reject(err)
          return
        }
        opened = true
        this.activeStreams.add(req)
        const unsubscribe = () => {
          if (closed) return
          closed = true
          this.activeStreams.delete(req)
          res.destroy()
          req.destroy()
        }
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buffer += chunk
          let idx: number
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const rawFrame = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            for (const line of rawFrame.split(/\r?\n/)) {
              if (!line.startsWith('data:')) continue
              const json = line.slice(5).trim()
              if (!json) continue
              try {
                const msg = JSON.parse(json) as { channel?: string; payload?: unknown }
                if (msg.channel === 'agent:event') listeners.onEvent?.(msg.payload as AgentEvent)
                else if (msg.channel === 'state:changed') listeners.onState?.(msg.payload as AppState)
              } catch {
                // ignore malformed SSE frames
              }
            }
          }
        })
        res.on('end', () => {
          this.activeStreams.delete(req)
          if (!closed) {
            closed = true
            listeners.onDisconnect?.()
          }
        })
        res.on('error', (err) => {
          this.activeStreams.delete(req)
          if (!closed) {
            closed = true
            listeners.onDisconnect?.(err)
          }
        })
        resolve(unsubscribe)
      })

      req.on('error', (err) => {
        this.activeStreams.delete(req)
        if (!opened) reject(new CliError(`Failed to open desktop event stream: ${err.message}`, EXIT_ERROR))
        else if (!closed) {
          closed = true
          listeners.onDisconnect?.(err)
        }
      })
      req.end()
    })
  }

  async close(): Promise<void> {
    for (const req of this.activeStreams) req.destroy()
    this.activeStreams.clear()
  }
}

export async function connectAttached(dataDir: string, timeoutMs = 500): Promise<AttachedCliRuntime | undefined> {
  const meta = readLocalControlMeta(dataDir)
  if (!meta) return undefined
  const health = await probeLocalControl(meta, timeoutMs)
  if (health) return new AttachedCliRuntime(dataDir, meta, health)

  // Clean up stale metadata if the desktop process is no longer alive.
  if (!isProcessAlive(meta.pid)) {
    try {
      fs.rmSync(localControlFilePath(dataDir), { force: true })
    } catch {
      // ignore cleanup failures
    }
  }
  return undefined
}
