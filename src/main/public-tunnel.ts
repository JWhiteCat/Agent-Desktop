import { localizedMessage, t as translate, type LocalizedMessage, type TranslationParams } from '@shared/i18n'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { PublicLinkStatus } from '@shared/types'

export const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000]
export const PUBLIC_SOCKET_DIR = '/run/agent-desktop'
const CLIENT_ID = /^[a-f0-9]{16}$/

const SSH_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/
const HOST_LABEL = /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])$/
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export interface TunnelTarget {
  user: string
  host: string
  /** SSH daemon port, independent of the HTTP gateway port. */
  sshPort: number
  /** Port the public gateway listens on. */
  port: number
  /** Local remote-control port the tunnel forwards to. */
  localPort: number
  /** Stable id used in the public URL and the server socket name. */
  clientId: string
}

export type SshSpawn = (command: string, args: string[], options: { windowsHide: boolean; stdio: ['ignore', 'ignore', 'pipe'] }) => ChildProcess

/** Preserve application messages when a validation failure is retained in remote status. */
export class LocalizedTunnelError extends Error {
  readonly localizedMessage: LocalizedMessage

  constructor(source: string, params?: TranslationParams) {
    const localized = localizedMessage(source, params)
    super(localized.text)
    this.localizedMessage = localized.message
  }
}

export function retryDelay(attempt: number): number {
  const i = Math.min(Math.max(0, attempt), RETRY_DELAYS_MS.length - 1)
  return RETRY_DELAYS_MS[i]
}

export function validatePublicUser(user: string): string {
  const value = user.trim()
  if (!SSH_USER.test(value)) throw new LocalizedTunnelError('SSH 用户名无效')
  return value
}

export function validatePublicHost(host: string): string {
  const value = host.trim()
  if (!value || value.includes('://') || value.includes('/') || value.includes('@') || /[\s:]/.test(value)) {
    throw new LocalizedTunnelError('服务器地址不能包含协议、端口或路径')
  }
  if (IPV4.test(value)) return value
  const labels = value.split('.')
  if (labels.every((label) => HOST_LABEL.test(label))) return value
  throw new LocalizedTunnelError('服务器地址无效')
}

export function validatePublicPort(port: number): number {
  const value = Math.trunc(Number(port))
  if (!(value >= 1 && value <= 65535) || value === 22) throw new LocalizedTunnelError('公网端口需在 1–65535 之间，且不能是 22')
  return value
}

export function validateSshPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new LocalizedTunnelError('SSH 端口需在 1–65535 之间')
  return port
}

export function validClientId(id: string): boolean {
  return CLIENT_ID.test(id)
}

export function newRemoteClientId(): string {
  return crypto.randomBytes(8).toString('hex')
}

export function publicSocketPath(clientId: string): string {
  if (!validClientId(clientId)) throw new LocalizedTunnelError('电脑标识无效')
  return `${PUBLIC_SOCKET_DIR}/${clientId}`
}

export function publicRemoteUrl(host: string, port: number, clientId: string, token: string): string {
  if (!validClientId(clientId)) throw new LocalizedTunnelError('电脑标识无效')
  return `http://${host}:${port}/c/${clientId}/?token=${encodeURIComponent(token)}`
}

export function buildSshArgs(target: TunnelTarget): string[] {
  return [
    '-N',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-p',
    String(validateSshPort(target.sshPort)),
    '-R',
    `${publicSocketPath(target.clientId)}:127.0.0.1:${target.localPort}`,
    `${target.user}@${target.host}`
  ]
}

export function resolveSshPath(): string {
  if (process.platform === 'win32') {
    const candidate = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
    if (fs.existsSync(candidate)) return candidate
  }
  return 'ssh'
}

export function explainSshFailure(text: string): string {
  const failure = sshFailure(text)
  return typeof failure === 'string' ? failure : translate(failure.source, failure.params)
}

function sshFailure(text: string): string | LocalizedMessage {
  const raw = text.trim()
  if (/permission denied/i.test(raw)) return { source: '公钥登录失败，请确认本机默认密钥能登录该用户' }
  if (/remote port forwarding failed|administratively prohibited|streamlocal|unix domain socket/i.test(raw)) {
    return { source: '反向隧道被拒绝。请重新运行 setup:public-server，确认服务器允许 Unix 套接字转发' }
  }
  if (/connection refused|timed out|no route|network is unreachable/i.test(raw)) return { source: '无法连接服务器' }
  if (/ENOENT|not found/i.test(raw)) return { source: '未找到 OpenSSH 客户端' }
  const line = raw
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ')
  return line || { source: '隧道已断开' }
}

const UNREACHABLE = '公网入口不可达。请确认已运行 setup:public-server，且安全组放行了该端口'

function probeReachable(host: string, port: number, clientId: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      req.destroy()
      resolve(ok)
    }
    const req = http.get({ host, port, path: `/c/${clientId}/api/public-health`, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        if (done) return
        size += chunk.length
        if (size > 4096) return finish(false)
        chunks.push(chunk)
      })
      res.on('aborted', () => finish(false))
      res.on('error', () => finish(false))
      // A normal close follows end; a close without end is a failed probe.
      res.on('close', () => finish(false))
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 500) return finish(false)
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok?: boolean; clientId?: string }
          finish(body.ok === true && body.clientId === clientId)
        } catch {
          finish(false)
        }
      })
    })
    // The socket timeout alone can be extended indefinitely by a trickling body.
    const deadline = setTimeout(() => finish(false), 5000)
    req.on('timeout', () => finish(false))
    req.on('error', () => finish(false))
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Keeps an SSH reverse tunnel to the configured server and reconnects if it drops. */
export class PublicTunnel {
  status: PublicLinkStatus = 'off'
  onChange: (() => void) | undefined

  private failure: string | LocalizedMessage | undefined
  private child: ChildProcess | undefined
  private timer: NodeJS.Timeout | undefined
  private generation = 0
  private attempt = 0
  private target: TunnelTarget | undefined

  constructor(
    private spawnFn: SshSpawn = spawn as SshSpawn,
    private sshPath = resolveSshPath(),
    private probe: (host: string, port: number, clientId: string) => Promise<boolean> = probeReachable
  ) {}

  get error(): string | undefined {
    return typeof this.failure === 'object' ? translate(this.failure.source, this.failure.params) : this.failure
  }

  get errorMessage(): LocalizedMessage | undefined {
    return typeof this.failure === 'object' ? this.failure : undefined
  }

  /** Stops any tunnel, then connects. Invalid targets should be rejected by the caller. */
  async start(target: TunnelTarget): Promise<void> {
    await this.stop()
    this.target = target
    this.attempt = 0
    this.launch()
  }

  async stop(): Promise<void> {
    this.generation += 1
    this.target = undefined
    this.clearTimer()
    const child = this.child
    this.child = undefined
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    this.status = 'off'
    this.failure = undefined
    this.emit()
  }

  private emit(): void {
    this.onChange?.()
  }

  private setStatus(status: PublicLinkStatus, error?: string | LocalizedMessage): void {
    this.status = status
    this.failure = error
    this.emit()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private launch(): void {
    const target = this.target
    if (!target) return
    // Every SSH attempt owns its probes; replies from a disconnected child may arrive late.
    const gen = ++this.generation
    this.clearTimer()
    this.setStatus('connecting')
    let stderr = ''
    let child: ChildProcess
    try {
      child = this.spawnFn(this.sshPath, buildSshArgs(target), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      this.setStatus('error', err instanceof LocalizedTunnelError ? err.localizedMessage : sshFailure(err instanceof Error ? err.message : String(err)))
      this.schedule(gen)
      return
    }
    this.child = child
    child.stderr?.on('data', (buf: Buffer) => {
      stderr = (stderr + buf.toString('utf8')).slice(-4000)
    })
    child.once('error', (err) => {
      if (gen !== this.generation) return
      this.child = undefined
      this.setStatus('error', sshFailure(err.message))
      this.schedule(gen)
    })
    child.once('exit', (code) => {
      if (gen !== this.generation) return
      this.child = undefined
      this.setStatus('error', stderr ? sshFailure(stderr) : { source: 'ssh 退出（{code}）', params: { code: code ?? 'unknown' } })
      this.schedule(gen)
    })
    void this.confirm(gen, target)
  }

  private async confirm(gen: number, target: TunnelTarget): Promise<void> {
    for (const wait of [800, 1200, 2000]) {
      await sleep(wait)
      if (gen !== this.generation || this.child === undefined) return
      const reachable = await this.probe(target.host, target.port, target.clientId)
      if (gen !== this.generation || this.child === undefined) return
      if (reachable) {
        this.attempt = 0
        this.setStatus('up')
        return
      }
    }
    if (gen !== this.generation || this.child === undefined) return
    this.setStatus('error', { source: UNREACHABLE })
    this.schedule(gen, () => { void this.confirm(gen, target) })
  }

  private schedule(gen: number, retry: () => void = () => this.launch()): void {
    if (gen !== this.generation || !this.target) return
    this.clearTimer()
    const delay = retryDelay(this.attempt)
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (gen !== this.generation) return
      retry()
    }, delay)
  }
}
