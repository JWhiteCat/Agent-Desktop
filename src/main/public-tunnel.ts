import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { PublicLinkStatus } from '@shared/types'

export const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000]

const SSH_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/
const HOST_LABEL = /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])$/
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export interface TunnelTarget {
  user: string
  host: string
  /** Port opened on the public server. */
  port: number
  /** Local remote-control port the tunnel forwards to. */
  localPort: number
}

export type SshSpawn = (command: string, args: string[], options: { windowsHide: boolean; stdio: ['ignore', 'ignore', 'pipe'] }) => ChildProcess

export function retryDelay(attempt: number): number {
  const i = Math.min(Math.max(0, attempt), RETRY_DELAYS_MS.length - 1)
  return RETRY_DELAYS_MS[i]
}

export function validatePublicUser(user: string): string {
  const value = user.trim()
  if (!SSH_USER.test(value)) throw new Error('SSH 用户名无效')
  return value
}

export function validatePublicHost(host: string): string {
  const value = host.trim()
  if (!value || value.includes('://') || value.includes('/') || value.includes('@') || /[\s:]/.test(value)) {
    throw new Error('服务器地址不能包含协议、端口或路径')
  }
  if (IPV4.test(value)) return value
  const labels = value.split('.')
  if (labels.every((label) => HOST_LABEL.test(label))) return value
  throw new Error('服务器地址无效')
}

export function validatePublicPort(port: number): number {
  const value = Math.trunc(Number(port))
  if (!(value >= 1 && value <= 65535) || value === 22) throw new Error('公网端口需在 1–65535 之间，且不能是 22')
  return value
}

export function publicRemoteUrl(host: string, port: number, token: string): string {
  return `http://${host}:${port}/?token=${encodeURIComponent(token)}`
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
    '-R',
    `0.0.0.0:${target.port}:127.0.0.1:${target.localPort}`,
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
  const raw = text.trim()
  if (/permission denied/i.test(raw)) return '公钥登录失败，请确认本机默认密钥能登录该用户'
  if (/remote port forwarding failed|administratively prohibited/i.test(raw)) {
    return '反向隧道被拒绝。请确认公网端口空闲，且服务器 GatewayPorts 为 clientspecified 或 yes'
  }
  if (/connection refused|timed out|no route|network is unreachable/i.test(raw)) return '无法连接服务器'
  if (/ENOENT|not found/i.test(raw)) return '未找到 OpenSSH 客户端'
  const line = raw
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ')
  return line || '隧道已断开'
}

const UNREACHABLE = '公网端口不可达。请确认安全组已放行该端口，且服务器 GatewayPorts 为 clientspecified 或 yes'

function probeReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: 5000 }, (res) => {
      res.resume()
      resolve((res.statusCode ?? 500) < 500)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Keeps an SSH reverse tunnel to the configured server and reconnects if it drops. */
export class PublicTunnel {
  status: PublicLinkStatus = 'off'
  error: string | undefined
  onChange: (() => void) | undefined

  private child: ChildProcess | undefined
  private timer: NodeJS.Timeout | undefined
  private generation = 0
  private attempt = 0
  private target: TunnelTarget | undefined

  constructor(
    private spawnFn: SshSpawn = spawn as SshSpawn,
    private sshPath = resolveSshPath(),
    private probe: (host: string, port: number) => Promise<boolean> = probeReachable
  ) {}

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
    this.error = undefined
    this.emit()
  }

  private emit(): void {
    this.onChange?.()
  }

  private setStatus(status: PublicLinkStatus, error?: string): void {
    this.status = status
    this.error = error
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
    const gen = this.generation
    this.clearTimer()
    this.setStatus('connecting')
    let stderr = ''
    let child: ChildProcess
    try {
      child = this.spawnFn(this.sshPath, buildSshArgs(target), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      this.setStatus('error', explainSshFailure(err instanceof Error ? err.message : String(err)))
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
      this.setStatus('error', explainSshFailure(err.message))
      this.schedule(gen)
    })
    child.once('exit', (code) => {
      if (gen !== this.generation) return
      this.child = undefined
      this.setStatus('error', explainSshFailure(stderr || `ssh 退出（${code ?? 'unknown'}）`))
      this.schedule(gen)
    })
    void this.confirm(gen, target)
  }

  private async confirm(gen: number, target: TunnelTarget): Promise<void> {
    for (const wait of [800, 1200, 2000]) {
      await sleep(wait)
      if (gen !== this.generation || this.child === undefined) return
      if (await this.probe(target.host, target.port)) {
        if (gen !== this.generation || this.child === undefined) return
        this.attempt = 0
        this.setStatus('up')
        return
      }
    }
    if (gen !== this.generation || this.child === undefined) return
    this.setStatus('error', UNREACHABLE)
  }

  private schedule(gen: number): void {
    if (gen !== this.generation || !this.target) return
    this.clearTimer()
    const delay = retryDelay(this.attempt)
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (gen !== this.generation) return
      this.launch()
    }, delay)
  }
}
