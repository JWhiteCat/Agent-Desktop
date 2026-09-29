import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type CliProvider, type ThreadMeta } from '../src/shared/types'
import type { Store } from '../src/main/store'
import { spawnClaudeAcp } from '../src/main/claude'
import { spawnCodexAcp } from '../src/main/codex'
import { killTree } from '../src/main/cli'
import { SessionManager } from '../src/main/sessions'

vi.mock('../src/main/skills', () => ({ syncAllManagedSkills: vi.fn() }))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(),
  killTree: vi.fn((child: ChildProcess) => child.emit('close', 0))
}))
vi.mock('../src/main/codex', async (original) => ({
  ...await original<typeof import('../src/main/codex')>(),
  resolveCodex: vi.fn(() => ({ bundled: true, display: 'Codex', acpEntry: '/mock/codex.js' })),
  resolveCodexApiKey: vi.fn((key: string) => key),
  spawnCodexAcp: vi.fn()
}))
vi.mock('../src/main/claude', async (original) => ({
  ...await original<typeof import('../src/main/claude')>(),
  resolveClaude: vi.fn(() => ({ bundled: true, display: 'Claude', acpEntry: '/mock/claude.js' })),
  resolveClaudeApiKey: vi.fn((key: string) => key),
  spawnClaudeAcp: vi.fn()
}))

function setup(provider: CliProvider = 'codex', apiKey = '') {
  const calls: Array<{ method: string; params: any }> = []
  const reply = vi.fn(async (method: string): Promise<any> => {
    if (method === 'initialize') return { agentCapabilities: { sessionCapabilities: { fork: {} } } }
    if (method === 'session/fork') return { sessionId: 'copied-session' }
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
        void reply(message.method).then(
          (result) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`),
          (error: Error) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } })}\n`)
        )
        callback()
      }
    })
  }) as unknown as ChildProcess
  vi.mocked(spawnCodexAcp).mockReturnValue(child)
  vi.mocked(spawnClaudeAcp).mockReturnValue(child)
  const thread = {
    id: 'source', projectId: 'project', chatId: 'source-session', cli: provider, cwd: os.tmpdir(), title: 'Source', mode: 'agent'
  } as ThreadMeta
  const store = {
    settings: { ...DEFAULT_SETTINGS, codexApiKey: apiKey, claudeApiKey: apiKey },
    thread: vi.fn(() => thread),
    project: vi.fn(() => ({ id: 'project', path: os.tmpdir() })),
    updateThread: vi.fn()
  }
  const emit = vi.fn()
  const onFinished = vi.fn()
  const manager = new SessionManager(store as unknown as Store, emit, vi.fn(), onFinished)
  return { manager, child, stdout, reply, calls, thread, store, emit, onFinished }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.useRealTimers())

describe('native session forks', () => {
  it.each(['', 'configured-key'])('forks Codex with the configured authentication without a prompt (key=%s)', async (apiKey) => {
    const ctx = setup('codex', apiKey)
    await expect(ctx.manager.forkSession('source')).resolves.toEqual({ chatId: 'copied-session', cwd: os.tmpdir() })
    expect(ctx.calls.map((call) => call.method)).toEqual(['initialize', 'authenticate', 'session/fork'])
    expect(ctx.calls[1].params).toEqual({ methodId: apiKey ? 'api-key' : 'chat-gpt' })
    expect(ctx.calls[2].params).toEqual({ sessionId: 'source-session', cwd: os.tmpdir(), mcpServers: [] })
    expect(spawnCodexAcp).toHaveBeenCalledWith(expect.anything(), os.tmpdir(), apiKey)
    expect(killTree).toHaveBeenCalledExactlyOnceWith(ctx.child)
    expect(ctx.store.updateThread).not.toHaveBeenCalled()
  })

  it('forks Claude using its process credentials and falls back to the project directory', async () => {
    const ctx = setup('claude', 'configured-key')
    ctx.thread.cwd = '/nonexistent-agent-desktop-fork-test-directory'
    await expect(ctx.manager.forkSession('source')).resolves.toMatchObject({ chatId: 'copied-session', cwd: os.tmpdir() })
    expect(ctx.calls.map((call) => call.method)).toEqual(['initialize', 'session/fork'])
    expect(spawnClaudeAcp).toHaveBeenCalledWith(expect.anything(), os.tmpdir(), 'configured-key')
    expect(killTree).toHaveBeenCalledExactlyOnceWith(ctx.child)
  })

  it('keeps the source idle process and commands separate from transient notifications and close events', async () => {
    const ctx = setup()
    const sourceProc = { child: {}, sessionId: 'source-session' }
    const internal = ctx.manager as any
    internal.agents.set('source', sourceProc)
    internal.commandLists.set('source', [{ name: 'kept', description: 'Source command' }])
    ctx.reply.mockImplementation(async (method) => {
      if (method === 'initialize') return { agentCapabilities: { sessionCapabilities: { fork: {} } } }
      if (method === 'session/fork') {
        ctx.stdout.write(`${JSON.stringify({ method: 'session/update', params: {
          sessionId: 'copied-session', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'transient' }] }
        } })}\n`)
        return { sessionId: 'copied-session' }
      }
      return {}
    })
    await ctx.manager.forkSession('source')
    expect(internal.agents.get('source')).toBe(sourceProc)
    expect(internal.commandLists.size).toBe(1)
    expect(internal.commandLists.get('source')).toEqual([{ name: 'kept', description: 'Source command' }])
    expect(ctx.emit).not.toHaveBeenCalled()
    expect(ctx.onFinished).not.toHaveBeenCalled()
  })

  it('rejects running conversations before launching a process', async () => {
    const ctx = setup()
    ;(ctx.manager as any).runs.set('source', {})
    await expect(ctx.manager.forkSession('source')).rejects.toThrow('对话正在运行')
    expect(spawnCodexAcp).not.toHaveBeenCalled()
  })

  it('rejects adapters that do not advertise forking and closes the process', async () => {
    const ctx = setup()
    ctx.reply.mockResolvedValue({})
    await expect(ctx.manager.forkSession('source')).rejects.toThrow('不支持会话分叉')
    expect(ctx.calls.some((call) => call.method === 'session/fork')).toBe(false)
    expect(killTree).toHaveBeenCalledExactlyOnceWith(ctx.child)
  })

  it('propagates fork failures and closes the process', async () => {
    const ctx = setup('claude')
    ctx.reply.mockImplementation(async (method) => {
      if (method === 'initialize') return { agentCapabilities: { sessionCapabilities: { fork: {} } } }
      throw new Error('The source transcript is missing')
    })
    await expect(ctx.manager.forkSession('source')).rejects.toThrow('The source transcript is missing')
    expect(killTree).toHaveBeenCalledExactlyOnceWith(ctx.child)
    expect(ctx.thread.chatId).toBe('source-session')
  })

  it.each(['', 'source-session'])('rejects a fork response without an independent session id (%s)', async (sessionId) => {
    const ctx = setup('claude')
    ctx.reply.mockImplementation(async (method) => method === 'initialize'
      ? { agentCapabilities: { sessionCapabilities: { fork: {} } } }
      : { sessionId })
    await expect(ctx.manager.forkSession('source')).rejects.toThrow('独立的分叉会话 id')
    expect(killTree).toHaveBeenCalledExactlyOnceWith(ctx.child)
  })

  it('times out an unresponsive adapter and releases its process', async () => {
    vi.useFakeTimers()
    const ctx = setup()
    ctx.reply.mockImplementation(() => new Promise(() => undefined))
    const result = expect(ctx.manager.forkSession('source')).rejects.toThrow('会话分叉超时')
    await vi.advanceTimersByTimeAsync(60_000)
    await result
    expect(killTree).toHaveBeenCalledExactlyOnceWith(ctx.child)
  })
})
