import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import http from 'node:http'
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
  validateSshPort,
  validatePublicUser,
  type TunnelTarget
} from '../src/main/public-tunnel'

describe('public tunnel settings', () => {
  it('validates default and custom SSH ports independently of the gateway port', () => {
    expect(validateSshPort(22)).toBe(22)
    expect(validateSshPort(2222)).toBe(2222)
    expect(validateSshPort(65535)).toBe(65535)
    for (const port of [0, -1, 65536, 22.5, NaN, Infinity]) expect(() => validateSshPort(port)).toThrow(/SSH/)
  })

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
      buildSshArgs({ user: 'root', host: '43.167.166.239', sshPort: 2222, port: 8765, localPort: 8765, clientId })
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
      '-p',
      '2222',
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
    user: 'user', host: 'example.com', sshPort: 22, port: 8765, localPort: 8765, clientId: 'aaaaaaaaaaaaaaaa'
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


describe('public tunnel HTTP health probes', () => {
  const target: TunnelTarget = {
    user: 'user', host: 'example.com', sshPort: 22, port: 8765, localPort: 8765, clientId: 'aaaaaaaaaaaaaaaa'
  }
  let tunnel: PublicTunnel
  let requests: { req: EventEmitter & { destroy: ReturnType<typeof vi.fn> }; res: EventEmitter & { statusCode: number } }[]

  beforeEach(() => {
    vi.useFakeTimers()
    requests = []
    vi.spyOn(http, 'get').mockImplementation(((_options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
      const req = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      const res = Object.assign(new EventEmitter(), { statusCode: 200 })
      requests.push({ req, res })
      queueMicrotask(() => callback(res as http.IncomingMessage))
      return req as unknown as http.ClientRequest
    }) as typeof http.get)
    tunnel = new PublicTunnel(() => new FakeSshChild() as unknown as ChildProcess, 'ssh')
  })

  afterEach(async () => {
    await tunnel.stop()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function firstProbe(): Promise<(typeof requests)[number]> {
    await tunnel.start(target)
    await vi.advanceTimersByTimeAsync(800)
    expect(requests).toHaveLength(1)
    return requests[0]
  }

  function healthy(res: EventEmitter): void {
    res.emit('data', Buffer.from(JSON.stringify({ ok: true, clientId: target.clientId })))
    res.emit('end')
    res.emit('close')
  }

  it.each(['aborted', 'error', 'close'])('retries after response %s without waiting for an end event', async (event) => {
    const { req, res } = await firstProbe()
    res.emit('data', Buffer.from('{"ok":'))
    res.emit(event, new Error('connection interrupted'))
    // A broken response may report several events for the same failure.
    res.emit('aborted')
    res.emit('error', new Error('connection reset'))
    res.emit('close')
    req.emit('error', new Error('socket closed'))
    await vi.advanceTimersByTimeAsync(1200)

    expect(requests).toHaveLength(2)
    expect(req.destroy).toHaveBeenCalledTimes(1)
    healthy(requests[1].res)
    await vi.advanceTimersByTimeAsync(0)
    expect(tunnel.status).toBe('up')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10000)
    expect(requests).toHaveLength(2)
  })

  it('does not leave a retry timer when an in-flight failure arrives after stop', async () => {
    const { res } = await firstProbe()
    await tunnel.stop()
    res.emit('aborted')
    await vi.advanceTimersByTimeAsync(0)
    expect(tunnel.status).toBe('off')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10000)
    expect(requests).toHaveLength(1)
  })

  it('bounds a stalled or trickling body by the total probe deadline', async () => {
    const { req, res } = await firstProbe()
    res.emit('data', Buffer.from('{"ok":'))
    for (let second = 0; second < 4; second += 1) {
      await vi.advanceTimersByTimeAsync(1000)
      res.emit('data', Buffer.from(' '))
    }
    expect(req.destroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(req.destroy).toHaveBeenCalledTimes(1)
    // A late valid-looking response cannot make a timed-out probe succeed.
    res.emit('data', Buffer.from('true,"clientId":"aaaaaaaaaaaaaaaa"}'))
    res.emit('end')
    await vi.advanceTimersByTimeAsync(1200)
    expect(requests).toHaveLength(2)
    expect(tunnel.status).toBe('connecting')
    healthy(requests[1].res)
    await vi.advanceTimersByTimeAsync(0)
    expect(tunnel.status).toBe('up')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['timeout', 'error'])('cleans up and retries after request %s', async (event) => {
    const { req } = await firstProbe()
    req.emit(event, new Error('request failed'))
    await vi.advanceTimersByTimeAsync(1200)
    expect(requests).toHaveLength(2)
    expect(req.destroy).toHaveBeenCalledTimes(1)
    healthy(requests[1].res)
    await vi.advanceTimersByTimeAsync(0)
    expect(tunnel.status).toBe('up')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up an oversized response and ignores late data', async () => {
    const { req, res } = await firstProbe()
    res.emit('data', Buffer.alloc(4097))
    res.emit('data', Buffer.alloc(4097))
    res.emit('end')
    await vi.advanceTimersByTimeAsync(1200)
    expect(requests).toHaveLength(2)
    expect(req.destroy).toHaveBeenCalledTimes(1)
    healthy(requests[1].res)
    await vi.advanceTimersByTimeAsync(0)
    expect(tunnel.status).toBe('up')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { status: 200, body: 'not json' },
    { status: 503, body: '{"ok":true,"clientId":"aaaaaaaaaaaaaaaa"}' },
    { status: 200, body: '{"ok":true,"clientId":"bbbbbbbbbbbbbbbb"}' }
  ])('retries a completed but invalid health response: $body ($status)', async ({ status, body }) => {
    const { req, res } = await firstProbe()
    res.statusCode = status
    res.emit('data', Buffer.from(body))
    res.emit('end')
    res.emit('close')
    await vi.advanceTimersByTimeAsync(1200)
    expect(requests).toHaveLength(2)
    expect(req.destroy).toHaveBeenCalledTimes(1)
    healthy(requests[1].res)
    await vi.advanceTimersByTimeAsync(0)
    expect(tunnel.status).toBe('up')
    expect(vi.getTimerCount()).toBe(0)
  })
})

it('recovers from a real HTTP connection closed in the middle of the health body', async () => {
  let requests = 0
  const server = http.createServer((_req, res) => {
    requests += 1
    if (requests > 1) {
      res.end(JSON.stringify({ ok: true, clientId: 'aaaaaaaaaaaaaaaa' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 200 })
    res.write('{"ok":')
    setImmediate(() => res.destroy())
  })
  const tunnel = new PublicTunnel(() => new FakeSshChild() as unknown as ChildProcess, 'ssh')
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server port')
    await tunnel.start({ user: 'user', host: '127.0.0.1', sshPort: 22, port: address.port, localPort: 8765, clientId: 'aaaaaaaaaaaaaaaa' })
    await expect.poll(() => tunnel.status, { timeout: 8000 }).toBe('up')
    expect(requests).toBe(2)
  } finally {
    await tunnel.stop()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
}, 10000)
