import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCodexAccountUsage } from '../src/main/codex-account'
import { killTree } from '../src/main/cli'
import { resolveCodex, spawnCodexAppServer } from '../src/main/codex'
import { parseCodexThreadUsage } from '../src/shared/codex-account'

vi.mock('../src/main/cli', () => ({ killTree: vi.fn((child: ChildProcess) => child.emit('close', 0)) }))
vi.mock('../src/main/codex', () => ({ resolveCodex: vi.fn(), spawnCodexAppServer: vi.fn() }))

const quotaResponse = {
  rateLimits: {
    limitId: 'codex',
    planType: 'pro',
    primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 2_000_000_000 },
    secondary: { usedPercent: 4, windowDurationMins: 10_080, resetsAt: 2_000_500_000 }
  }
}

function threadResponse(threadId = 'thread-a', credits: unknown = 2_500_000, costUsd: unknown = 150_000) {
  return { threadUsage: { threadId, estimatedUsageCreditsMicros: credits, estimatedUsageUsdMicros: costUsd } }
}

function server() {
  const calls: Array<{ method: string; params: any }> = []
  const reply = vi.fn(async (method: string, params: any): Promise<unknown> => {
    if (method === 'account/rateLimits/read') return quotaResponse
    if (method === 'account/usage/read') return threadResponse(params.threadId)
    return {}
  })
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    exitCode: null,
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(chunk.toString())
        calls.push({ method: message.method, params: message.params })
        if (message.id !== undefined) {
          void reply(message.method, message.params).then(
            (result) => stdout.write(`${JSON.stringify({ id: message.id, result })}\n`),
            (error: Error) => stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: error.message } })}\n`)
          )
        }
        callback()
      }
    })
  }) as unknown as ChildProcess
  vi.mocked(spawnCodexAppServer).mockReturnValueOnce(child)
  return { child, calls, reply }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(resolveCodex).mockReturnValue({ bundled: true, display: 'Codex', acpEntry: '/mock/codex.js' })
  vi.mocked(killTree).mockImplementation((child) => { child.emit('close', 0) })
})
afterEach(() => vi.useRealTimers())

describe('Codex thread billing parser', () => {
  it('converts integer microcredits and microdollars without combining threads', () => {
    expect(parseCodexThreadUsage(threadResponse(), 'thread-a')).toEqual({ threadId: 'thread-a', credits: 2.5, costUsd: 0.15 })
    expect(parseCodexThreadUsage(threadResponse(), 'thread-b')).toBeUndefined()
    expect(parseCodexThreadUsage(threadResponse(''), '')).toBeUndefined()
  })

  it('preserves explicit zero charges and omits unavailable USD estimates', () => {
    expect(parseCodexThreadUsage(threadResponse('thread-a', 0, 0), 'thread-a')).toEqual({ threadId: 'thread-a', credits: 0, costUsd: 0 })
    expect(parseCodexThreadUsage(threadResponse('thread-a', 1, null), 'thread-a')).toEqual({ threadId: 'thread-a', credits: 0.000001 })
    const missingUsd = { threadUsage: { threadId: 'thread-a', estimatedUsageCreditsMicros: 1 } }
    expect(parseCodexThreadUsage(missingUsd, 'thread-a')).toEqual({ threadId: 'thread-a', credits: 0.000001 })
  })

  it.each([null, undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1000'])('rejects unsafe or missing credit amounts: %s', (credits) => {
    const body = threadResponse()
    body.threadUsage.estimatedUsageCreditsMicros = credits
    expect(parseCodexThreadUsage(body, 'thread-a')).toBeUndefined()
  })

  it('does not fabricate usage for unavailable or malformed responses', () => {
    for (const body of [{}, null, { threadUsage: null }, { threadUsage: [] }, { threadUsage: { threadId: 'thread-a' } }]) {
      expect(parseCodexThreadUsage(body, 'thread-a')).toBeUndefined()
    }
    expect(parseCodexThreadUsage(threadResponse('thread-a', 1, -1), 'thread-a')).toEqual({ threadId: 'thread-a', credits: 0.000001 })
  })
})

describe('read-only Codex account RPC client', () => {
  it('negotiates experimental read APIs, returns both readings, and closes the process', async () => {
    const ctx = server()
    const result = await loadCodexAccountUsage('custom-codex', 'thread-a')
    expect(resolveCodex).toHaveBeenCalledWith('custom-codex')
    expect(ctx.calls).toEqual([
      { method: 'initialize', params: { clientInfo: { name: 'agent-desktop-usage', title: 'Agent Desktop', version: '0.1.0' }, capabilities: { experimentalApi: true } } },
      { method: 'initialized', params: {} },
      { method: 'account/rateLimits/read', params: {} },
      { method: 'account/usage/read', params: { threadId: 'thread-a' } }
    ])
    expect(result.threadUsage).toEqual({ threadId: 'thread-a', credits: 2.5, costUsd: 0.15 })
    expect(result.quota?.windows).toMatchObject([{ label: '5小时', usedPercent: 15 }, { label: '每周', usedPercent: 4 }])
    expect(result.quotaSampledAt).toEqual(expect.any(Number))
    expect(killTree).toHaveBeenCalledExactlyOnceWith(ctx.child)
  })

  it('keeps simultaneous thread responses isolated', async () => {
    const first = server()
    const second = server()
    second.reply.mockImplementation(async (method, params) => method === 'account/usage/read' ? threadResponse(params.threadId, 7_000_000, null) : {})
    const [a, b] = await Promise.all([loadCodexAccountUsage('', 'thread-a'), loadCodexAccountUsage('', 'thread-b')])
    expect(a.threadUsage).toEqual({ threadId: 'thread-a', credits: 2.5, costUsd: 0.15 })
    expect(b.threadUsage).toEqual({ threadId: 'thread-b', credits: 7 })
    expect(first.calls.at(-1)?.params).toEqual({ threadId: 'thread-a' })
    expect(second.calls.at(-1)?.params).toEqual({ threadId: 'thread-b' })
    expect(killTree).toHaveBeenCalledTimes(2)
  })

  it.each(['account/rateLimits/read', 'account/usage/read'])('preserves the other reading when %s is unsupported', async (unsupported) => {
    const ctx = server()
    ctx.reply.mockImplementation(async (method, params) => {
      if (method === unsupported) throw new Error('Method not found')
      return method === 'account/usage/read' ? threadResponse(params.threadId) : quotaResponse
    })
    const result = await loadCodexAccountUsage('', 'thread-a')
    expect(Boolean(result.quota)).toBe(unsupported !== 'account/rateLimits/read')
    expect(Boolean(result.threadUsage)).toBe(unsupported !== 'account/usage/read')
    if (unsupported === 'account/rateLimits/read') expect(result.quotaSampledAt).toBeUndefined()
    expect(killTree).toHaveBeenCalledExactlyOnceWith(ctx.child)
  })

  it('rejects a response belonging to another thread while retaining quota', async () => {
    const ctx = server()
    ctx.reply.mockImplementation(async (method) => method === 'account/usage/read' ? threadResponse('different-thread') : quotaResponse)
    const result = await loadCodexAccountUsage('', 'thread-a')
    expect(result.threadUsage).toBeUndefined()
    expect(result.quota?.windows).toHaveLength(2)
  })

  it.each(['account/rateLimits/read', 'account/usage/read'])('retains partial success when %s times out and kills the process', async (stalled) => {
    vi.useFakeTimers()
    const ctx = server()
    ctx.reply.mockImplementation(async (method, params) => {
      if (method === stalled) return new Promise(() => undefined)
      return method === 'account/usage/read' ? threadResponse(params.threadId) : quotaResponse
    })
    const pending = loadCodexAccountUsage('', 'thread-a')
    await vi.advanceTimersByTimeAsync(8_000)
    const result = await pending
    expect(Boolean(result.quota)).toBe(stalled !== 'account/rateLimits/read')
    expect(Boolean(result.threadUsage)).toBe(stalled !== 'account/usage/read')
    expect(killTree).toHaveBeenCalledExactlyOnceWith(ctx.child)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('applies the same deadline to initialization', async () => {
    vi.useFakeTimers()
    const ctx = server()
    ctx.reply.mockReturnValue(new Promise(() => undefined))
    const pending = loadCodexAccountUsage('', 'thread-a')
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await pending).toEqual({})
    expect(ctx.calls.map((call) => call.method)).toEqual(['initialize'])
    expect(killTree).toHaveBeenCalledExactlyOnceWith(ctx.child)
  })

  it('timestamps quota when that RPC returns even when thread usage arrives much later', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const ctx = server()
    ctx.reply.mockImplementation(async (method, params) => {
      if (method === 'account/rateLimits/read') return new Promise((resolve) => setTimeout(() => resolve(quotaResponse), 200))
      if (method === 'account/usage/read') return new Promise((resolve) => setTimeout(() => resolve(threadResponse(params.threadId)), 6_000))
      return {}
    })
    const pending = loadCodexAccountUsage('', 'thread-a')
    await vi.advanceTimersByTimeAsync(6_000)
    const result = await pending
    expect(result.quotaSampledAt).toBe(1_000_200)
    expect(Date.now()).toBe(1_006_000)
    expect(result.threadUsage?.credits).toBe(2.5)
  })

  it('does not timestamp an invalid quota response', async () => {
    const ctx = server()
    ctx.reply.mockImplementation(async (method, params) => method === 'account/usage/read' ? threadResponse(params.threadId) : {})
    const result = await loadCodexAccountUsage('', 'thread-a')
    expect(result.quota).toBeUndefined()
    expect(result.quotaSampledAt).toBeUndefined()
    expect(result.threadUsage?.credits).toBe(2.5)
  })

  it('contains an asynchronous spawn error', async () => {
    const ctx = server()
    const pending = loadCodexAccountUsage('', 'thread-a')
    ctx.child.emit('error', new Error('spawn failed'))
    expect(await pending).toEqual({})
    expect(killTree).toHaveBeenCalledExactlyOnceWith(ctx.child)
  })

  it('contains stdin write failures and removes error handlers when the process closes', async () => {
    const ctx = server()
    Object.assign(ctx.child, {
      stdin: new Writable({
        write(_chunk, _encoding, callback) {
          callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
        }
      })
    })
    expect(await loadCodexAccountUsage('', 'thread-a')).toEqual({})
    expect(killTree).toHaveBeenCalledExactlyOnceWith(ctx.child)
    expect(ctx.child.listenerCount('error')).toBe(0)
    expect(ctx.child.stdin?.listenerCount('error')).toBe(0)
  })

  it('contains initialization failure or early process exit', async () => {
    const failed = server()
    failed.reply.mockRejectedValue(new Error('unsupported initialize'))
    expect(await loadCodexAccountUsage('', 'thread-a')).toEqual({})
    const closed = server()
    const pending = loadCodexAccountUsage('', 'thread-a')
    closed.child.emit('close', 1)
    expect(await pending).toEqual({})
  })

  it('returns no data when thread identity, executable, or spawn is unavailable', async () => {
    expect(await loadCodexAccountUsage('', '')).toEqual({})
    expect(spawnCodexAppServer).not.toHaveBeenCalled()
    vi.mocked(spawnCodexAppServer).mockImplementation(() => { throw new Error('unavailable') })
    expect(await loadCodexAccountUsage('', 'thread-a')).toEqual({})
    vi.mocked(resolveCodex).mockReturnValue(undefined)
    expect(await loadCodexAccountUsage('', 'thread-a')).toEqual({})
  })
})
