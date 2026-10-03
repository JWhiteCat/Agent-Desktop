import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '../src/shared/i18n'
import { DEFAULT_SETTINGS, type AppState, type Settings } from '../src/shared/types'
import { PublicTunnel, type TunnelTarget } from '../src/main/public-tunnel'
import { RemoteRuntime } from '../src/main/remote-runtime'
import type { Store } from '../src/main/store'

const target: TunnelTarget = {
  user: 'user', host: 'example.com', sshPort: 22, port: 8765, localPort: 8765, clientId: 'aaaaaaaaaaaaaaaa'
}

class FakeSshChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stderr = new PassThrough()

  exit(code: number | null): void {
    this.exitCode = code
    this.emit('exit', code)
  }

  kill(): boolean {
    this.signalCode = 'SIGTERM'
    queueMicrotask(() => this.exit(null))
    return true
  }
}

const tunnels: PublicTunnel[] = []

beforeEach(() => {
  setLanguage('en')
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  for (const tunnel of tunnels.splice(0)) await tunnel.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  setLanguage('system', 'zh-CN')
})

function runtimeFixture(patch: Partial<Settings> = {}) {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    remoteEnabled: true,
    remotePublicEnabled: true,
    remoteToken: 'test-token',
    remoteClientId: target.clientId,
    remotePublicUser: target.user,
    remotePublicHost: target.host,
    ...patch
  }
  const state: AppState = { projects: [], threads: [], running: [], settings }
  const store = { settings, updateSettings: (next: Partial<Settings>) => Object.assign(settings, next) } as unknown as Store
  return new RemoteRuntime(() => store, () => state)
}

describe('cached remote errors', () => {
  it('updates port conflicts and blocked-tunnel messages without restarting the server', async () => {
    const runtime = runtimeFixture({ remotePort: 9876 })
    const start = vi.spyOn(runtime.server, 'start').mockRejectedValue(Object.assign(new Error('listen failed'), { code: 'EADDRINUSE' }))
    const stop = vi.spyOn(runtime.tunnel, 'stop').mockResolvedValue()
    await runtime.apply()
    const english = runtime.info()
    expect(english.error).toBe('Port 9876 is already in use. Choose another port.')
    expect(english.errorMessage).toEqual({ source: '端口 {port} 已被占用，请换一个端口', params: { port: 9876 } })
    expect(english.publicError).toBe('Cannot open the public tunnel because the LAN server is not running')

    setLanguage('zh-CN')
    expect(runtime.info().error).toBe('端口 9876 已被占用，请换一个端口')
    expect(runtime.info().publicError).toBe('局域网服务未启动，无法建立公网隧道')
    // The renderer can translate an already received snapshot without another RPC.
    expect(t(english.errorMessage!.source, english.errorMessage!.params)).toBe(runtime.info().error)
    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('retains validation-message sources when tunnel setup fails', async () => {
    const runtime = runtimeFixture({ remotePublicUser: '-invalid' })
    vi.spyOn(runtime.server, 'start').mockResolvedValue()
    vi.spyOn(runtime.server, 'running', 'get').mockReturnValue(true)
    const start = vi.spyOn(runtime.tunnel, 'start').mockResolvedValue()
    vi.spyOn(runtime.tunnel, 'stop').mockResolvedValue()
    await runtime.apply()
    expect(runtime.info().publicError).toBe('Invalid SSH username')

    setLanguage('zh-CN')
    expect(runtime.info().publicError).toBe('SSH 用户名无效')
    expect(runtime.info().publicErrorMessage).toEqual({ source: 'SSH 用户名无效' })
    expect(start).not.toHaveBeenCalled()
  })

  it('preserves unknown server errors even when their text matches a translation key', async () => {
    const runtime = runtimeFixture({ remotePublicEnabled: false })
    vi.spyOn(runtime.server, 'start').mockRejectedValue(new Error('设置'))
    await runtime.apply()
    expect(runtime.info().error).toBe('设置')
    expect(runtime.info().errorMessage).toBeUndefined()
    setLanguage('zh-CN')
    expect(runtime.info().error).toBe('设置')
  })
})

describe('cached SSH errors', () => {
  it('retranslates recognized failures without creating another SSH process', async () => {
    const spawn = vi.fn(() => { throw new Error('Permission denied (publickey)') })
    const tunnel = new PublicTunnel(spawn, 'ssh')
    tunnels.push(tunnel)
    await tunnel.start(target)
    expect(tunnel.error).toContain('Public key sign-in failed')

    setLanguage('zh-CN')
    expect(tunnel.error).toBe('公钥登录失败，请确认本机默认密钥能登录该用户')
    expect(tunnel.errorMessage).toEqual({ source: '公钥登录失败，请确认本机默认密钥能登录该用户' })
    expect(tunnel.status).toBe('error')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('keeps raw SSH output unchanged across languages', async () => {
    const tunnel = new PublicTunnel(() => { throw new Error('设置') }, 'ssh')
    tunnels.push(tunnel)
    await tunnel.start(target)
    expect(tunnel.error).toBe('设置')
    expect(tunnel.errorMessage).toBeUndefined()
    setLanguage('zh-CN')
    expect(tunnel.error).toBe('设置')
  })

  it('preserves the exit code in a translatable fallback message', async () => {
    const child = new FakeSshChild()
    const tunnel = new PublicTunnel(() => child as unknown as ChildProcess, 'ssh')
    tunnels.push(tunnel)
    await tunnel.start(target)
    child.exit(7)
    expect(tunnel.error).toBe('ssh exited (7)')
    setLanguage('zh-CN')
    expect(tunnel.error).toBe('ssh 退出（7）')
    expect(tunnel.errorMessage?.params).toEqual({ code: 7 })
  })

  it('retranslates failed health checks without reconnecting or probing again', async () => {
    const child = new FakeSshChild()
    const spawn = vi.fn(() => child as unknown as ChildProcess)
    const probe = vi.fn().mockResolvedValue(false)
    const tunnel = new PublicTunnel(spawn, 'ssh', probe)
    tunnels.push(tunnel)
    await tunnel.start(target)
    await vi.advanceTimersByTimeAsync(4000)
    expect(tunnel.error).toContain('The public gateway is unreachable')

    setLanguage('zh-CN')
    expect(tunnel.error).toBe('公网入口不可达。请确认已运行 setup:public-server，且安全组放行了该端口')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(3)
    expect(tunnel.status).toBe('error')
  })
})
