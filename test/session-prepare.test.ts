import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ThreadMeta } from '../src/shared/types'
import type { Store } from '../src/main/store'
import { spawnCli, killTree } from '../src/main/cli'
import { SessionManager } from '../src/main/sessions'

vi.mock('../src/main/skills', () => ({ syncAllManagedSkills: vi.fn() }))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(),
  resolveCli: vi.fn(() => ({ command: 'mock-agent', prefixArgs: [] })),
  resolveApiKey: vi.fn(() => 'configured-key'),
  spawnCli: vi.fn(),
  killTree: vi.fn((child: ChildProcess) => child.emit('close', 0))
}))

function setup(blockedMethod?: string) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const stdout = new PassThrough()
  const commands = [{ name: 'help', description: 'Show commands' }]
  const notifyCommands = () => stdout.write(`${JSON.stringify({
    method: 'session/update',
    params: { sessionId: 'saved-session', update: { sessionUpdate: 'available_commands_update', availableCommands: commands } }
  })}\n`)
  const reply = vi.fn(async (method: string) => {
    if (method === blockedMethod) await gate
    if (method === 'session/load') notifyCommands()
    return {}
  })
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    exitCode: null,
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(chunk.toString())
        void reply(message.method).then((result) => {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
        })
        callback()
      }
    })
  }) as unknown as ChildProcess
  vi.mocked(spawnCli).mockReturnValue(child)
  const thread = {
    id: 'thread', projectId: 'project', chatId: 'saved-session', cli: 'cursor', mode: 'ask'
  } as ThreadMeta
  const store = {
    settings: { ...DEFAULT_SETTINGS },
    thread: vi.fn(() => thread),
    project: () => ({ id: 'project', path: os.tmpdir() }),
    updateThread: vi.fn()
  }
  const emit = vi.fn()
  const manager = new SessionManager(store as unknown as Store, emit, vi.fn(), vi.fn())
  const prepare = () => manager.prepare('thread', { model: 'composer-2.5[fast=true]', mode: 'ask', force: false })
  return { manager, prepare, child, reply, release, store, emit, commands, notifyCommands }
}

beforeEach(() => vi.clearAllMocks())

describe('preparing a saved session', () => {
  it('does not start queued or new processes after shutdown', async () => {
    const ctx = setup('initialize')
    const first = ctx.prepare().then(() => null, (error: Error) => error)
    const queued = ctx.prepare().then(() => null, (error: Error) => error)
    try {
      await vi.waitFor(() => expect(ctx.reply).toHaveBeenCalledWith('initialize'))
      ctx.manager.stopAll()
      ctx.release()
      expect(await first).toBeInstanceOf(Error)
      expect(await queued).toMatchObject({ message: '应用正在关闭' })
      await expect(ctx.prepare()).rejects.toThrow('应用正在关闭')
      expect(spawnCli).toHaveBeenCalledTimes(1)
    } finally {
      killTree(ctx.child)
      ctx.release()
      await Promise.all([first, queued])
      ctx.manager.stopAll()
    }
  })

  it('keeps the connected process and cached commands until disposal', async () => {
    const ctx = setup()
    try {
      await expect(ctx.prepare()).resolves.toEqual(ctx.commands)
      await expect(ctx.prepare()).resolves.toEqual(ctx.commands)
      expect(spawnCli).toHaveBeenCalledTimes(1)
      expect(killTree).not.toHaveBeenCalled()
      expect(ctx.store.updateThread).toHaveBeenCalledWith('thread', { chatId: 'saved-session', cwd: os.tmpdir() })
      ctx.manager.dispose('thread')
      expect(killTree).toHaveBeenCalledWith(ctx.child)
    } finally {
      ctx.manager.stopAll()
    }
  })

  it.each([
    ['dispose', 'initialize'], ['dispose', 'session/load'],
    ['dropIdle', 'initialize'], ['dropIdle', 'session/load'],
    ['stopAll', 'initialize'], ['stopAll', 'session/load']
  ] as const)('%s cancels a process still waiting for %s', async (action, blockedMethod) => {
    const ctx = setup(blockedMethod)
    const pending = ctx.prepare().then(() => null, (error: Error) => error)
    try {
      await vi.waitFor(() => expect(ctx.reply).toHaveBeenCalledWith(blockedMethod))
      if (action === 'dispose') ctx.manager.dispose('thread')
      else ctx.manager[action]()
      expect(killTree).toHaveBeenCalledWith(ctx.child)
      ctx.release()
      expect(await pending).toBeInstanceOf(Error)
      expect(ctx.store.updateThread).not.toHaveBeenCalled()
      ctx.notifyCommands()
      expect(ctx.emit).not.toHaveBeenCalled()
    } finally {
      killTree(ctx.child)
      ctx.release()
      await pending
      ctx.manager.stopAll()
    }
  })
})
