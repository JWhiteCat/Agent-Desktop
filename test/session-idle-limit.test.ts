import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Item, type ThreadMeta } from '../src/shared/types'
import type { Store } from '../src/main/store'
import { spawnCli, killTree } from '../src/main/cli'
import { DEFAULT_MAX_IDLE_AGENTS, SessionManager } from '../src/main/sessions'

vi.mock('../src/main/skills', () => ({ syncAllManagedSkills: vi.fn() }))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(),
  resolveCli: vi.fn(() => ({ command: 'mock-agent', prefixArgs: [] })),
  resolveApiKey: vi.fn(() => 'configured-key'),
  spawnCli: vi.fn(),
  killTree: vi.fn((child: ChildProcess) => {
    ;(child as { exitCode: number | null }).exitCode = 0
    child.emit('close', 0)
  })
}))

interface MockChild {
  child: ChildProcess
  releasePrompt: () => void
  promptStarted: Promise<void>
}

let tempDir = ''

function makeChild(sessionId: string, holdPrompt = false): MockChild {
  const stdout = new PassThrough()
  let releasePrompt = () => {}
  let markPromptStarted = () => {}
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve })
  const promptGate = holdPrompt
    ? new Promise<void>((resolve) => { releasePrompt = resolve })
    : Promise.resolve()

  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    exitCode: null as number | null,
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(chunk.toString())
        const respond = (result: unknown) => {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
        }
        if (message.method === 'session/new') {
          respond({ sessionId })
        } else if (message.method === 'session/load') {
          stdout.write(`${JSON.stringify({
            method: 'session/update',
            params: { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'help', description: 'Help' }] } }
          })}\n`)
          respond({})
        } else if (message.method === 'session/prompt') {
          markPromptStarted()
          void promptGate.then(() => respond({ stopReason: 'end_turn' }))
        } else {
          respond({})
        }
        callback()
      }
    })
  }) as unknown as ChildProcess

  return { child, releasePrompt, promptStarted }
}

function createHarness(maxIdleAgents = 2) {
  const threads = new Map<string, ThreadMeta>()
  const threadItems = new Map<string, Item[]>()
  const ensureThread = (id: string, chatId?: string): ThreadMeta => {
    let thread = threads.get(id)
    if (!thread) {
      thread = { id, projectId: 'project', chatId, cli: 'cursor', mode: 'agent', model: 'auto' } as ThreadMeta
      threads.set(id, thread)
      threadItems.set(id, [])
    }
    return thread
  }
  const store = {
    dataDir: tempDir,
    settings: { ...DEFAULT_SETTINGS },
    thread: vi.fn((id: string) => threads.get(id)),
    items: vi.fn((id: string) => threadItems.get(id) ?? []),
    project: () => ({ id: 'project', path: tempDir }),
    updateThread: vi.fn((id: string, patch: Partial<ThreadMeta>) => {
      const current = threads.get(id)
      if (!current) return undefined
      const updated = { ...current, ...patch }
      threads.set(id, updated)
      return updated
    }),
    markItemsDirty: vi.fn()
  }
  const finished = vi.fn()
  const manager = new SessionManager(
    store as unknown as Store,
    vi.fn(),
    vi.fn(),
    finished,
    undefined,
    undefined,
    undefined,
    maxIdleAgents
  )
  const runTurn = async (id: string) => {
    const before = finished.mock.calls.length
    await manager.send({ threadId: id, prompt: 'hi', model: 'auto', mode: 'agent', force: false })
    await vi.waitFor(() => expect(finished.mock.calls.length).toBeGreaterThan(before))
  }
  return { manager, ensureThread, runTurn, finished }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(spawnCli).mockReset()
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-idle-limit-'))
})

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('idle agent LRU cap', () => {
  it('defaults to keeping 6 idle processes', () => {
    expect(DEFAULT_MAX_IDLE_AGENTS).toBe(6)
  })

  it('evicts the least-recently-used idle process when a new thread finishes', async () => {
    const h = createHarness(2)
    h.ensureThread('t1')
    h.ensureThread('t2')
    h.ensureThread('t3')
    const p1 = makeChild('s1')
    const p2 = makeChild('s2')
    const p3 = makeChild('s3')
    const p1Respawn = makeChild('s1')
    vi.mocked(spawnCli)
      .mockReturnValueOnce(p1.child)
      .mockReturnValueOnce(p2.child)
      .mockReturnValueOnce(p3.child)
      .mockReturnValueOnce(p1Respawn.child)

    try {
      await h.runTurn('t1')
      await h.runTurn('t2')
      expect(killTree).not.toHaveBeenCalled()

      // Third thread pushes idle count to 3 -> oldest (t1) is evicted.
      await h.runTurn('t3')
      expect(killTree).toHaveBeenCalledTimes(1)
      expect(killTree).toHaveBeenCalledWith(p1.child)

      // Reusing t2 promotes it to MRU and does not respawn.
      await h.runTurn('t2')
      expect(spawnCli).toHaveBeenCalledTimes(3)
      expect(killTree).toHaveBeenCalledTimes(1)

      // Sending to evicted t1 respawns a process and evicts t3 (now oldest), keeping t2 + t1.
      await h.runTurn('t1')
      expect(spawnCli).toHaveBeenCalledTimes(4)
      expect(killTree).toHaveBeenCalledTimes(2)
      expect(killTree).toHaveBeenLastCalledWith(p3.child)
    } finally {
      h.manager.stopAll()
    }
  })

  it('evicts oldest idle process after prepare() exceeds the cap', async () => {
    const h = createHarness(2)
    h.ensureThread('t1', 's1')
    h.ensureThread('t2', 's2')
    h.ensureThread('t3', 's3')
    const p1 = makeChild('s1')
    const p2 = makeChild('s2')
    const p3 = makeChild('s3')
    vi.mocked(spawnCli)
      .mockReturnValueOnce(p1.child)
      .mockReturnValueOnce(p2.child)
      .mockReturnValueOnce(p3.child)

    try {
      await h.manager.prepare('t1', { model: 'auto', mode: 'agent', force: false })
      await h.manager.prepare('t2', { model: 'auto', mode: 'agent', force: false })
      expect(killTree).not.toHaveBeenCalled()

      await h.manager.prepare('t3', { model: 'auto', mode: 'agent', force: false })
      expect(killTree).toHaveBeenCalledTimes(1)
      expect(killTree).toHaveBeenCalledWith(p1.child)
    } finally {
      h.manager.stopAll()
    }
  })

  it('never evicts a thread that is still running a turn', async () => {
    const h = createHarness(1)
    h.ensureThread('t1')
    h.ensureThread('t2')
    h.ensureThread('t3')
    const p1 = makeChild('s1')
    const held = makeChild('s2', true)
    const p3 = makeChild('s3')
    vi.mocked(spawnCli)
      .mockReturnValueOnce(p1.child)
      .mockReturnValueOnce(held.child)
      .mockReturnValueOnce(p3.child)

    try {
      await h.runTurn('t1')

      // Start t2 (running, held) while t1 is idle
      const sendT2 = h.manager.send({ threadId: 't2', prompt: 'long', model: 'auto', mode: 'agent', force: false })
      await held.promptStarted
      expect(h.manager.isRunning('t2')).toBe(true)

      // Finish t3 -> idle cap is 1, so idle t1 is evicted, while running t2 is untouched
      await h.runTurn('t3')
      expect(killTree).toHaveBeenCalledWith(p1.child)
      expect(killTree).not.toHaveBeenCalledWith(held.child)
      expect(h.manager.isRunning('t2')).toBe(true)

      // Release t2 -> once t2 finishes and parks, idle t3 is evicted
      const before = h.finished.mock.calls.length
      held.releasePrompt()
      await sendT2
      await vi.waitFor(() => expect(h.finished.mock.calls.length).toBeGreaterThan(before))
      expect(killTree).toHaveBeenCalledWith(p3.child)
    } finally {
      h.manager.stopAll()
    }
  })
})
