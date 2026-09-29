import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSshArgs,
  explainSshFailure,
  newRemoteClientId,
  publicRemoteUrl,
  publicSocketPath,
  PublicTunnel,
  retryDelay,
  validClientId,
  validatePublicHost,
  validatePublicPort,
  validatePublicUser,
  type TunnelTarget
} from '../src/main/public-tunnel'

describe('public tunnel settings', () => {
  it('accepts a user, host and port', () => {
    expect(validatePublicUser(' root ')).toBe('root')
    expect(validatePublicHost('43.167.166.239')).toBe('43.167.166.239')
    expect(validatePublicHost('example.com')).toBe('example.com')
    expect(validatePublicPort(8765)).toBe(8765)
  })

  it('rejects schemes, paths, port 22 and bad names', () => {
    expect(() => validatePublicUser('-root')).toThrow(/用户名/)
    expect(() => validatePublicUser('')).toThrow(/用户名/)
    expect(() => validatePublicHost('http://43.167.166.239')).toThrow(/协议/)
    expect(() => validatePublicHost('43.167.166.239/app')).toThrow(/协议/)
    expect(() => validatePublicHost('root@host')).toThrow(/协议/)
    expect(() => validatePublicHost('host:8765')).toThrow(/协议/)
    expect(() => validatePublicPort(22)).toThrow(/22/)
    expect(() => validatePublicPort(0)).toThrow(/22/)
    expect(() => validatePublicPort(70000)).toThrow(/22/)
  })

  it('builds the reverse-forward command and the public link', () => {
    const clientId = 'aaaaaaaaaaaaaaaa'
    expect(validClientId(clientId)).toBe(true)
    expect(validClientId('short')).toBe(false)
    expect(newRemoteClientId()).toMatch(/^[a-f0-9]{16}$/)
    expect(publicSocketPath(clientId)).toBe('/run/agent-desktop/aaaaaaaaaaaaaaaa')
    expect(
      buildSshArgs({ user: 'root', host: '43.167.166.239', port: 8765, localPort: 8765, clientId })
    ).toEqual([
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
      '/run/agent-desktop/aaaaaaaaaaaaaaaa:127.0.0.1:8765',
      'root@43.167.166.239'
    ])
    expect(publicRemoteUrl('example.com', 9000, clientId, 'a b')).toBe(
      'http://example.com:9000/c/aaaaaaaaaaaaaaaa/?token=a%20b'
    )
    expect(retryDelay(0)).toBe(1000)
    expect(retryDelay(3)).toBe(10000)
    expect(retryDelay(9)).toBe(10000)
  })

  it('turns ssh failures into short messages', () => {
    expect(explainSshFailure('root@host: Permission denied (publickey).')).toMatch(/公钥/)
    expect(explainSshFailure('Error: remote port forwarding failed for listen port 8765')).toMatch(/Unix 套接字/)
    expect(explainSshFailure('connect to address: Connection timed out')).toMatch(/无法连接/)
    expect(explainSshFailure('')).toBe('隧道已断开')
  })
})

class FakeSshChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stderr = new PassThrough()

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }

  kill(): boolean {
    queueMicrotask(() => this.exit(null, 'SIGTERM'))
    return true
  }
}

describe('public tunnel health recovery', () => {
  const target: TunnelTarget = {
    user: 'user', host: 'example.com', port: 8765, localPort: 8765, clientId: 'aaaaaaaaaaaaaaaa'
  }
  let children: FakeSshChild[]
  let tunnel: PublicTunnel
  let probe: ReturnType<typeof vi.fn<(host: string, port: number, clientId: string) => Promise<boolean>>>

  beforeEach(() => {
    vi.useFakeTimers()
    children = []
    probe = vi.fn<(host: string, port: number, clientId: string) => Promise<boolean>>().mockResolvedValue(false)
    tunnel = new PublicTunnel(() => {
      const child = new FakeSshChild()
      children.push(child)
      return child as unknown as ChildProcess
    }, 'ssh', probe)
  })

  afterEach(async () => {
    await tunnel.stop()
    vi.useRealTimers()
  })

  it('recovers when the gateway becomes reachable after the initial health checks fail', async () => {
    await tunnel.start(target)
    await vi.advanceTimersByTimeAsync(4000)
    expect(probe).toHaveBeenCalledTimes(3)
    expect(tunnel.status).toBe('error')

    probe.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(2000)

    expect(tunnel.status).toBe('up')
    expect(tunnel.error).toBeUndefined()
    expect(children).toHaveLength(1)
  })

  it('ignores health responses from the previous SSH connection', async () => {
    let finishOldProbe!: (reachable: boolean) => void
    probe.mockImplementationOnce(() => new Promise((resolve) => { finishOldProbe = resolve })).mockResolvedValue(true)
    await tunnel.start(target)
    await vi.advanceTimersByTimeAsync(800)
    children[0].exit(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(children).toHaveLength(2)
    expect(tunnel.status).toBe('connecting')

    finishOldProbe(true)
    await Promise.resolve()
    expect(tunnel.status).toBe('connecting')

    await vi.advanceTimersByTimeAsync(800)
    expect(tunnel.status).toBe('up')
  })

  it('cancels pending health retries when stopped', async () => {
    await tunnel.start(target)
    await vi.advanceTimersByTimeAsync(4000)
    await tunnel.stop()
    await vi.advanceTimersByTimeAsync(30000)

    expect(tunnel.status).toBe('off')
    expect(probe).toHaveBeenCalledTimes(3)
    expect(children).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
