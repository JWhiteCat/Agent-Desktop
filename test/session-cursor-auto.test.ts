import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Item, type NoticeItem, type SendRequest, type ThreadMeta } from '../src/shared/types'
import type { Store } from '../src/main/store'
import { spawnCli } from '../src/main/cli'
import { SessionManager } from '../src/main/sessions'

vi.mock('../src/main/skills', () => ({ syncAllManagedSkills: vi.fn() }))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(),
  resolveCli: vi.fn(() => ({ command: 'mock-agent', prefixArgs: [] })),
  resolveApiKey: vi.fn(() => 'configured-key'),
  spawnCli: vi.fn(),
  killTree: vi.fn((child: ChildProcess) => {
    Object.assign(child, { exitCode: 0 })
    child.emit('close', 0)
  })
}))

type Call = [method: string, params: any]

/** A Cursor ACP process. `reject` lists methods the adapter does not support. */
function fakeCursor(calls: Call[][], reject: Set<string>) {
  vi.mocked(spawnCli).mockImplementation(() => {
    const own: Call[] = []
    calls.push(own)
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      exitCode: null,
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          const message = JSON.parse(chunk.toString())
          if (message.id === undefined) return callback()
          own.push([message.method, message.params])
          const response = reject.has(message.method)
            ? { error: { code: -32601, message: `Method not found: ${message.method}` } }
            : { result: message.method === 'session/new' ? { sessionId: 'chat-1' } : message.method === 'session/prompt' ? { stopReason: 'end_turn' } : {} }
          setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response })}\n`))
          callback()
        }
      })
    }) as unknown as ChildProcess
    return child
  })
}

function setup(reject: string[] = []) {
  const calls: Call[][] = []
  fakeCursor(calls, new Set(reject))
  const items: Item[] = []
  const thread = { id: 'thread', projectId: 'project', title: 'Task', cli: 'cursor', mode: 'agent', createdAt: 1, updatedAt: 1, source: 'app' } as ThreadMeta
  const store = {
    settings: { ...DEFAULT_SETTINGS },
    thread: vi.fn(() => thread),
    project: () => ({ id: 'project', path: os.tmpdir() }),
    items: () => items,
    markItemsDirty: vi.fn(),
    updateThread: vi.fn((_id: string, patch: Partial<ThreadMeta>) => Object.assign(thread, patch))
  }
  const manager = new SessionManager(store as unknown as Store, vi.fn(), vi.fn(), vi.fn())
  const send = async (model: string) => {
    const req: SendRequest = { threadId: 'thread', prompt: `use ${model}`, model, mode: 'agent', force: false }
    await manager.send(req)
    await vi.waitFor(() => expect(manager.isRunning('thread')).toBe(false))
    return items.at(-1)
  }
  /** Model requests sent before each prompt, per process. */
  const modelRequests = () =>
    calls.map((own) => {
      const turns: Call[][] = [[]]
      for (const call of own) {
        if (call[0] === 'session/prompt') turns.push([])
        else if (call[0] === 'session/set_model' || (call[0] === 'session/set_config_option' && call[1].configId === 'model')) turns.at(-1)!.push(call)
      }
      return turns.slice(0, -1)
    })
  return { manager, send, calls, modelRequests, thread }
}

const setConfig = (value: string): Call => ['session/set_config_option', { sessionId: 'chat-1', configId: 'model', value }]
const setModel = (modelId: string): Call => ['session/set_model', { sessionId: 'chat-1', modelId }]

beforeEach(() => vi.clearAllMocks())

describe('switching a Cursor session back to Auto', () => {
  it('resets the model on a reused process: concrete, Auto, concrete', async () => {
    const ctx = setup()
    try {
      await ctx.send('composer-2.5')
      await ctx.send('auto')
      await ctx.send('composer-2.5')
      expect(spawnCli).toHaveBeenCalledTimes(1)
      expect(ctx.modelRequests()).toEqual([[[setConfig('composer-2.5')], [setConfig('auto')], [setConfig('composer-2.5')]]])
    } finally {
      ctx.manager.stopAll()
    }
  })

  it('resets the model when a new process loads a chat that used another model', async () => {
    const ctx = setup()
    try {
      await ctx.send('composer-2.5')
      ctx.manager.dispose('thread')
      await ctx.send('auto')
      expect(spawnCli).toHaveBeenCalledTimes(2)
      expect(vi.mocked(spawnCli).mock.calls[1][1]).not.toContain('--model')
      expect(ctx.calls[1].map((call) => call[0])).toContain('session/load')
      expect(ctx.modelRequests()[1]).toEqual([[setConfig('auto')]])
    } finally {
      ctx.manager.stopAll()
    }
  })

  it('falls back to session/set_model on an adapter without the model config option', async () => {
    const ctx = setup(['session/set_config_option'])
    try {
      await ctx.send('composer-2.5')
      await ctx.send('auto')
      expect(spawnCli).toHaveBeenCalledTimes(1)
      expect(ctx.modelRequests()).toEqual([[
        [setConfig('composer-2.5'), setModel('composer-2.5')],
        [setConfig('auto'), setModel('auto')]
      ]])
    } finally {
      ctx.manager.stopAll()
    }
  })

  it('reports a failed reset instead of running Auto turns on the previous model, then recovers', async () => {
    const ctx = setup(['session/set_config_option', 'session/set_model'])
    try {
      expect(await ctx.send('composer-2.5')).toMatchObject({ kind: 'result', isError: false })
      const failed = await ctx.send('auto')
      expect(failed).toMatchObject({ kind: 'notice', level: 'error' })
      expect((failed as NoticeItem).text).toContain('Cursor CLI 无法切回 Auto 模型')
      // The Auto turn was not prompted on the old model.
      expect(ctx.calls[0].filter((call) => call[0] === 'session/prompt')).toHaveLength(1)
      // The process was restarted, so the next Auto turn starts without --model.
      expect(await ctx.send('auto')).toMatchObject({ kind: 'result', isError: false })
      expect(spawnCli).toHaveBeenCalledTimes(2)
      expect(vi.mocked(spawnCli).mock.calls[1][1]).not.toContain('--model')
    } finally {
      ctx.manager.stopAll()
    }
  })

  it('keeps an Auto-only conversation working on an adapter without either request', async () => {
    const ctx = setup(['session/set_config_option', 'session/set_model'])
    try {
      expect(await ctx.send('auto')).toMatchObject({ kind: 'result', isError: false })
      expect(await ctx.send('auto')).toMatchObject({ kind: 'result', isError: false })
      expect(spawnCli).toHaveBeenCalledTimes(1)
    } finally {
      ctx.manager.stopAll()
    }
  })
})
