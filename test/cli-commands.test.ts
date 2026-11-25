import { PassThrough, Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  type AgentEvent,
  type AppState,
  type Item,
  type MessageQueue,
  type Project,
  type QuestionItem,
  type SendRequest,
  type ThreadMeta
} from '@shared/types'
import { runCliCommand } from '../src/cli/commands/cli-info'
import { writeJson } from '../src/cli/commands/helpers'
import { runProjectsCommand } from '../src/cli/commands/projects'
import { runAnswerCommand, runPromptCommand, runStopCommand, runWatchCommand } from '../src/cli/commands/run'
import { runStatus } from '../src/cli/commands/status'
import { runThreadsCommand } from '../src/cli/commands/threads'
import { isPromptAbortError, promptQuestionInteractively } from '../src/cli/prompt-ui'
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_QUESTION_REQUIRED,
  EXIT_SIGINT,
  type CliIo,
  type CliRuntime
} from '../src/cli/types'

interface MockListener {
  onEvent?: (event: AgentEvent) => void
  onState?: (state: AppState) => void
  onDisconnect?: (err?: Error) => void
}

function createIo(opts?: { stdinText?: string; stdinStream?: PassThrough; isTTY?: boolean; cwd?: string }): {
  io: CliIo
  out: () => string
  err: () => string
} {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const stdin = (opts?.stdinStream ??
    Readable.from(opts?.stdinText ? [Buffer.from(opts.stdinText, 'utf8')] : [])) as NodeJS.ReadableStream & {
    isTTY?: boolean
  }
  stdin.isTTY = Boolean(opts?.isTTY)
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      cb()
    }
  }) as Writable & { isTTY?: boolean }
  stdout.isTTY = Boolean(opts?.isTTY)
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      cb()
    }
  }) as Writable & { isTTY?: boolean }
  stderr.isTTY = Boolean(opts?.isTTY)
  return {
    io: {
      stdout,
      stderr,
      stdin,
      cwd: () => opts?.cwd ?? process.cwd(),
      env: { ...process.env }
    },
    out: () => stdoutChunks.join(''),
    err: () => stderrChunks.join('')
  }
}

function makeProject(id = 'proj-1'): Project {
  return { id, name: 'demo', path: '/tmp/demo', createdAt: 1 }
}

function makeThread(id = 'thr-1', projectId = 'proj-1'): ThreadMeta {
  return {
    id,
    projectId,
    title: 'Demo Thread',
    mode: 'agent',
    model: 'auto',
    force: false,
    cli: 'cursor',
    source: 'app',
    createdAt: 1,
    updatedAt: 1
  }
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    systemLocale: 'en-US',
    projects: [makeProject()],
    threads: [makeThread()],
    settings: { ...DEFAULT_SETTINGS },
    running: [],
    starting: [],
    waitingForInput: [],
    queued: {},
    ...overrides
  }
}

function createMockRuntime(opts: {
  mode?: 'attached' | 'headless'
  call: (channel: string, ...args: unknown[]) => unknown | Promise<unknown>
  onSubscribe?: (listener: MockListener) => void | Promise<void>
}): {
  runtime: CliRuntime
  emitEvent: (event: AgentEvent) => void
  emitState: (state: AppState) => void
  listeners: Set<MockListener>
} {
  const listeners = new Set<MockListener>()
  const runtime: CliRuntime = {
    mode: opts.mode ?? 'attached',
    dataDir: '/tmp/ad-test-data',
    desktopPid: 12345,
    appVersion: '1.0.0-test',
    call: async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
      (await opts.call(channel, ...args)) as T,
    subscribe: async (listener) => {
      listeners.add(listener)
      await opts.onSubscribe?.(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close: async () => {}
  }
  return {
    runtime,
    listeners,
    emitEvent: (event) => {
      for (const l of listeners) l.onEvent?.(event)
    },
    emitState: (state) => {
      for (const l of listeners) l.onState?.(state)
    }
  }
}

function expectSingleLineJsonl(raw: string, expectedLines = 1): unknown[] {
  const trimmed = raw.trimEnd()
  expect(trimmed.length).toBeGreaterThan(0)
  const lines = trimmed.split('\n')
  expect(lines).toHaveLength(expectedLines)
  return lines.map((line) => JSON.parse(line))
}

describe('CLI Bug #4: runPromptCommand --queue / --now waiting across handoff', () => {
  it('waits for --queue turn across transient idle state:changed during dispatchHead handoff', async () => {
    const thread = makeThread('thr-q')
    let running: string[] = [thread.id]
    let queued: Record<string, MessageQueue> = {}
    const items: Item[] = [{ id: 'u1', kind: 'user', text: 'first turn', createdAt: 1 }]
    const snapshot = (): AppState => makeState({ threads: [thread], running: [...running], queued: { ...queued } })

    const mock = createMockRuntime({
      call: (channel, ...args) => {
        if (channel === 'state:get') return snapshot()
        if (channel === 'thread:items') return [...items]
        if (channel === 'agent:send') {
          const req = args[0] as SendRequest
          expect(req.delivery).toBe('queue')
          queued = {
            [thread.id]: {
              items: [
                {
                  id: 'q-2',
                  prompt: req.prompt,
                  attachments: [],
                  model: req.model,
                  mode: req.mode,
                  force: req.force,
                  createdAt: 2
                }
              ]
            }
          }
          mock.emitState(snapshot())

          // Turn 1 completes while q-2 is still queued.
          setTimeout(() => {
            items.push(
              { id: 'a1', kind: 'assistant', text: 'turn 1 reply' },
              { id: 'r1', kind: 'result', isError: true, durationMs: 10 }
            )
            running = []
            mock.emitEvent({ type: 'items', threadId: thread.id, items: [...items] })
            mock.emitEvent({ type: 'running', threadId: thread.id, running: false })
            mock.emitState(snapshot())
          }, 10)

          // SessionQueue.dispatchHead() pops q-2 and broadcasts transient idle state BEFORE Turn 2 enters running.
          setTimeout(() => {
            queued = {}
            mock.emitState(snapshot())
          }, 20)

          // Turn 2 starts after async startup (launchFingerprint / openTurnProc) and completes.
          setTimeout(() => {
            items.push({ id: 'u2', kind: 'user', text: req.prompt, createdAt: 3 })
            running = [thread.id]
            mock.emitEvent({ type: 'running', threadId: thread.id, running: true })
            mock.emitState(snapshot())
            items.push({ id: 'a2', kind: 'assistant', text: 'turn 2 reply' })
            mock.emitEvent({ type: 'items', threadId: thread.id, items: [...items] })
          }, 35)

          setTimeout(() => {
            items.push({ id: 'r2', kind: 'result', isError: false, durationMs: 25 })
            running = []
            mock.emitEvent({ type: 'items', threadId: thread.id, items: [...items] })
            mock.emitEvent({ type: 'running', threadId: thread.id, running: false })
            mock.emitState(snapshot())
          }, 50)
          return
        }
        throw new Error(`Unexpected RPC: ${channel}`)
      }
    })

    const buf = createIo()
    const code = await runPromptCommand(mock.runtime, buf.io, ['second turn'], {
      format: 'json',
      thread: thread.id,
      queue: true
    })

    expect(code).toBe(EXIT_OK)
    const result = JSON.parse(buf.out())
    expect(result).toMatchObject({
      ok: true,
      threadId: thread.id,
      text: 'turn 2 reply',
      isError: false
    })
  })

  it('waits for --now turn even when a paused queue item existed before and handoff emits transient idle', async () => {
    const thread = makeThread('thr-now')
    let running: string[] = [thread.id]
    let queued: Record<string, MessageQueue> = {
      [thread.id]: {
        paused: true,
        items: [
          { id: 'q-old', prompt: 'paused old', attachments: [], model: 'auto', mode: 'agent', force: false, createdAt: 1 }
        ]
      }
    }
    const items: Item[] = [{ id: 'u1', kind: 'user', text: 'running turn', createdAt: 1 }]
    const snapshot = (): AppState => makeState({ threads: [thread], running: [...running], queued: { ...queued } })

    const mock = createMockRuntime({
      call: (channel, ...args) => {
        if (channel === 'state:get') return snapshot()
        if (channel === 'thread:items') return [...items]
        if (channel === 'agent:send') {
          const req = args[0] as SendRequest
          expect(req.delivery).toBe('now')
          queued = {
            [thread.id]: {
              paused: true,
              items: [
                {
                  id: 'q-now',
                  prompt: req.prompt,
                  attachments: [],
                  model: req.model,
                  mode: req.mode,
                  force: req.force,
                  immediate: true,
                  createdAt: 2
                },
                ...queued[thread.id].items
              ]
            }
          }
          mock.emitState(snapshot())

          // Turn 1 is stopped.
          setTimeout(() => {
            running = []
            mock.emitEvent({ type: 'running', threadId: thread.id, running: false })
            mock.emitState(snapshot())
          }, 10)

          // dispatchHead pops q-now, leaving q-old paused (non-runnable) and thread temporarily idle.
          setTimeout(() => {
            queued = {
              [thread.id]: {
                paused: true,
                items: [queued[thread.id].items[1]]
              }
            }
            mock.emitState(snapshot())
          }, 20)

          // Urgent Turn 2 starts and completes.
          setTimeout(() => {
            items.push({ id: 'u-now', kind: 'user', text: req.prompt, createdAt: 3 })
            running = [thread.id]
            mock.emitEvent({ type: 'running', threadId: thread.id, running: true })
            mock.emitState(snapshot())
            items.push(
              { id: 'a-now', kind: 'assistant', text: 'urgent reply' },
              { id: 'r-now', kind: 'result', isError: false, durationMs: 15 }
            )
            running = []
            mock.emitEvent({ type: 'items', threadId: thread.id, items: [...items] })
            mock.emitEvent({ type: 'running', threadId: thread.id, running: false })
            mock.emitState(snapshot())
          }, 35)
          return
        }
        throw new Error(`Unexpected RPC: ${channel}`)
      }
    })

    const buf = createIo()
    const code = await runPromptCommand(mock.runtime, buf.io, ['urgent task'], {
      format: 'text',
      quiet: true,
      thread: thread.id,
      now: true
    })

    expect(code).toBe(EXIT_OK)
    expect(buf.out()).toBe('urgent reply\n')
  })

  it('surfaces dispatch error if a queued turn fails to start and is re-queued with paused + error', async () => {
    const thread = makeThread('thr-fail')
    let running: string[] = [thread.id]
    let queued: Record<string, MessageQueue> = {}
    const items: Item[] = [{ id: 'u1', kind: 'user', text: 'turn 1', createdAt: 1 }]
    const snapshot = (): AppState => makeState({ threads: [thread], running: [...running], queued: { ...queued } })

    const mock = createMockRuntime({
      call: (channel, ...args) => {
        if (channel === 'state:get') return snapshot()
        if (channel === 'thread:items') return [...items]
        if (channel === 'agent:send') {
          const req = args[0] as SendRequest
          queued = {
            [thread.id]: {
              items: [{ id: 'q-fail', prompt: req.prompt, attachments: [], model: req.model, mode: req.mode, force: req.force, createdAt: 2 }]
            }
          }
          mock.emitState(snapshot())
          setTimeout(() => {
            running = []
            mock.emitEvent({ type: 'running', threadId: thread.id, running: false })
            mock.emitState(snapshot())
          }, 10)
          setTimeout(() => {
            queued = {}
            mock.emitState(snapshot())
          }, 20)
          setTimeout(() => {
            queued = {
              [thread.id]: {
                paused: true,
                error: 'CLI binary not found',
                items: [{ id: 'q-fail', prompt: req.prompt, attachments: [], model: req.model, mode: req.mode, force: req.force, createdAt: 2 }]
              }
            }
            mock.emitState(snapshot())
          }, 30)
          return
        }
        throw new Error(`Unexpected RPC: ${channel}`)
      }
    })

    const buf = createIo()
    await expect(
      runPromptCommand(mock.runtime, buf.io, ['will fail'], { format: 'text', thread: thread.id, queue: true })
    ).rejects.toThrow('CLI binary not found')
  })
})

describe('CLI Bug #14: --format jsonl emits single-line compact JSON across all commands', () => {
  it('writeJson emits compact single-line JSON for jsonl and pretty-printed JSON for json', () => {
    const jsonBuf = createIo()
    writeJson(jsonBuf.io, { a: 1, b: [2, 3] }, 'json')
    expect(jsonBuf.out()).toContain('\n  "a": 1')

    const jsonlBuf = createIo()
    writeJson(jsonlBuf.io, { a: 1, b: [2, 3] }, 'jsonl')
    expect(jsonlBuf.out()).toBe('{"a":1,"b":[2,3]}\n')
  })

  it('emits single-line JSONL in status, projects, threads, cli, stop, answer, run --detach, and question_required', async () => {
    const project = makeProject('p1')
    const thread = makeThread('t1', 'p1')
    const items: Item[] = [{ id: 'u1', kind: 'user', text: 'hi', createdAt: 1 }]
    let running: string[] = []
    const state = (): AppState => makeState({ projects: [project], threads: [thread], running: [...running] })

    const mock = createMockRuntime({
      call: (channel, ...args) => {
        switch (channel) {
          case 'state:get':
            return state()
          case 'cli:info':
            return { found: true, path: '/bin/cli', version: '1.0', authStatus: 'authenticated' }
          case 'cli:models':
            return [{ id: 'gpt-5', label: 'GPT-5' }]
          case 'project:add':
            return project
          case 'thread:items':
            return items
          case 'thread:create':
            return thread
          case 'thread:fork':
            return { thread: makeThread('t2', 'p1'), items: [] }
          case 'thread:syncFromCli':
            return items
          case 'thread:delete':
            return undefined
          case 'agent:send': {
            const req = args[0] as SendRequest
            if (req.prompt === 'ASK_Q') {
              running = [thread.id]
              mock.emitEvent({ type: 'running', threadId: thread.id, running: true })
              mock.emitState(state())
              setTimeout(() => {
                const q: QuestionItem = {
                  id: 'q1',
                  kind: 'question',
                  toolCallId: 'tc1',
                  title: 'Pick',
                  questions: [{ id: 'k1', prompt: 'Choose', options: [{ id: 'o1', label: 'One' }] }],
                  status: 'pending'
                }
                mock.emitEvent({ type: 'items', threadId: thread.id, items: [...items, q] })
              }, 10)
            }
            return undefined
          }
          case 'agent:stop':
          case 'agent:answerQuestion':
            running = []
            return undefined
          default:
            throw new Error(`Unexpected channel: ${channel}`)
        }
      }
    })

    const statusBuf = createIo()
    expect(await runStatus(mock.runtime, statusBuf.io, { format: 'jsonl' })).toBe(EXIT_OK)
    expectSingleLineJsonl(statusBuf.out(), 1)

    const projListBuf = createIo()
    expect(await runProjectsCommand(mock.runtime, projListBuf.io, 'list', [], { format: 'jsonl' })).toBe(EXIT_OK)
    expectSingleLineJsonl(projListBuf.out(), 1)

    const projAddBuf = createIo()
    expect(await runProjectsCommand(mock.runtime, projAddBuf.io, 'add', ['.'], { format: 'jsonl' })).toBe(EXIT_OK)
    expectSingleLineJsonl(projAddBuf.out(), 1)

    for (const [sub, pos] of [
      ['list', []],
      ['show', ['t1']],
      ['create', []],
      ['fork', ['t1']],
      ['sync', ['t1']],
      ['delete', ['t1']]
    ] as const) {
      const buf = createIo()
      expect(await runThreadsCommand(mock.runtime, buf.io, sub, [...pos], { format: 'jsonl', project: 'p1' })).toBe(EXIT_OK)
      expectSingleLineJsonl(buf.out(), 1)
    }

    const cliListBuf = createIo()
    expect(await runCliCommand(mock.runtime, cliListBuf.io, 'list', [], { format: 'jsonl' })).toBe(EXIT_OK)
    expectSingleLineJsonl(cliListBuf.out(), 1)

    const cliModelsBuf = createIo()
    expect(await runCliCommand(mock.runtime, cliModelsBuf.io, 'models', ['cursor'], { format: 'jsonl' })).toBe(EXIT_OK)
    expectSingleLineJsonl(cliModelsBuf.out(), 1)

    const detachBuf = createIo()
    expect(await runPromptCommand(mock.runtime, detachBuf.io, ['hi'], { format: 'jsonl', thread: 't1', detach: true })).toBe(EXIT_OK)
    expectSingleLineJsonl(detachBuf.out(), 1)

    const stopBuf = createIo()
    expect(await runStopCommand(mock.runtime, stopBuf.io, ['t1'], { format: 'jsonl' })).toBe(EXIT_OK)
    expectSingleLineJsonl(stopBuf.out(), 1)

    const ansBuf = createIo()
    expect(await runAnswerCommand(mock.runtime, ansBuf.io, ['t1', 'q1'], { format: 'jsonl', skip: true })).toBe(EXIT_OK)
    expectSingleLineJsonl(ansBuf.out(), 1)

    // Mid-stream question_required in jsonl mode: run.start + question + question_required = 3 valid single-line JSONL records.
    const qBuf = createIo()
    expect(
      await runPromptCommand(mock.runtime, qBuf.io, ['ASK_Q'], {
        format: 'jsonl',
        thread: 't1',
        onQuestion: 'fail'
      })
    ).toBe(EXIT_QUESTION_REQUIRED)
    const parsed = expectSingleLineJsonl(qBuf.out(), 3) as Array<Record<string, unknown>>
    expect(parsed[0].type).toBe('run.start')
    expect(parsed[1].type).toBe('question')
    expect(parsed[2]).toMatchObject({ ok: false, reason: 'question_required', threadId: 't1', questionId: 'q1' })
  })
})

describe('CLI Bug #29: Ctrl+C / SIGINT during interactive question prompt exits with EXIT_SIGINT (130)', () => {
  const sampleQuestion: QuestionItem = {
    id: 'q-int',
    kind: 'question',
    toolCallId: 'tc-int',
    title: 'Confirm',
    questions: [{ id: 'q1', prompt: 'Proceed?', options: [{ id: 'yes', label: 'Yes' }] }],
    status: 'pending'
  }

  it('promptQuestionInteractively rejects with AbortError on Ctrl+C (\\x03) and on AbortSignal', async () => {
    const stdin1 = new PassThrough()
    const buf1 = createIo({ stdinStream: stdin1, isTTY: true })
    const p1 = promptQuestionInteractively(sampleQuestion, buf1.io)
    setTimeout(() => stdin1.write('\x03'), 15)
    const err1 = await p1.catch((e) => e)
    expect(isPromptAbortError(err1)).toBe(true)

    const stdin2 = new PassThrough()
    const buf2 = createIo({ stdinStream: stdin2, isTTY: true })
    const ac = new AbortController()
    const p2 = promptQuestionInteractively(sampleQuestion, buf2.io, ac.signal)
    setTimeout(() => ac.abort(), 15)
    const err2 = await p2.catch((e) => e)
    expect(isPromptAbortError(err2)).toBe(true)
  })

  it('runPromptCommand stops the turn and returns EXIT_SIGINT (130) when Ctrl+C is pressed at interactive question prompt', async () => {
    const thread = makeThread('thr-sigint')
    let running: string[] = []
    const items: Item[] = []
    const stopped: string[] = []
    const snapshot = (): AppState => makeState({ threads: [thread], running: [...running] })

    const mock = createMockRuntime({
      call: (channel, ...args) => {
        if (channel === 'state:get') return snapshot()
        if (channel === 'thread:items') return [...items]
        if (channel === 'agent:send') {
          const req = args[0] as SendRequest
          items.push({ id: 'u1', kind: 'user', text: req.prompt, createdAt: 1 })
          running = [thread.id]
          mock.emitEvent({ type: 'running', threadId: thread.id, running: true })
          mock.emitState(snapshot())
          setTimeout(() => {
            items.push(sampleQuestion)
            mock.emitEvent({ type: 'items', threadId: thread.id, items: [...items] })
          }, 10)
          return
        }
        if (channel === 'agent:stop') {
          stopped.push(args[0] as string)
          running = []
          mock.emitEvent({ type: 'running', threadId: thread.id, running: false })
          mock.emitState(snapshot())
          return
        }
        throw new Error(`Unexpected RPC: ${channel}`)
      }
    })

    const stdin = new PassThrough()
    const buf = createIo({ stdinStream: stdin, isTTY: true })
    setTimeout(() => stdin.write('\x03'), 30)

    const code = await runPromptCommand(mock.runtime, buf.io, ['ask me'], {
      format: 'text',
      thread: thread.id,
      onQuestion: 'interactive'
    })

    expect(code).toBe(EXIT_SIGINT)
    expect(stopped).toEqual([thread.id])
    expect(buf.err()).toContain('[interrupt] Stopping run...')
  })

  it('runPromptCommand aborts an active interactive prompt and returns EXIT_SIGINT (130) on process SIGINT', async () => {
    const thread = makeThread('thr-proc-sigint')
    let running: string[] = []
    const items: Item[] = []
    const stopped: string[] = []
    const snapshot = (): AppState => makeState({ threads: [thread], running: [...running] })

    const mock = createMockRuntime({
      call: (channel, ...args) => {
        if (channel === 'state:get') return snapshot()
        if (channel === 'thread:items') return [...items]
        if (channel === 'agent:send') {
          const req = args[0] as SendRequest
          items.push({ id: 'u1', kind: 'user', text: req.prompt, createdAt: 1 })
          running = [thread.id]
          mock.emitEvent({ type: 'running', threadId: thread.id, running: true })
          mock.emitState(snapshot())
          setTimeout(() => {
            items.push(sampleQuestion)
            mock.emitEvent({ type: 'items', threadId: thread.id, items: [...items] })
          }, 10)
          return
        }
        if (channel === 'agent:stop') {
          stopped.push(args[0] as string)
          running = []
          mock.emitEvent({ type: 'running', threadId: thread.id, running: false })
          mock.emitState(snapshot())
          return
        }
        throw new Error(`Unexpected RPC: ${channel}`)
      }
    })

    const stdin = new PassThrough()
    const buf = createIo({ stdinStream: stdin, isTTY: true })
    setTimeout(() => {
      process.emit('SIGINT')
    }, 30)

    const code = await runPromptCommand(mock.runtime, buf.io, ['ask me too'], {
      format: 'text',
      thread: thread.id,
      onQuestion: 'interactive'
    })

    expect(code).toBe(EXIT_SIGINT)
    expect(stopped).toEqual([thread.id])
  })
})

describe('CLI Bug #30: runWatchCommand completion race and queued turns', () => {
  it('does not hang when the turn finishes between initial state:get and subscribe(), and renders final items', async () => {
    const thread = makeThread('thr-race')
    let stateGetCount = 0
    const items: Item[] = [{ id: 'u1', kind: 'user', text: 'fast turn', createdAt: 1 }]

    const mock = createMockRuntime({
      call: (channel) => {
        if (channel === 'state:get') {
          stateGetCount++
          // First state:get sees thread running; by the second state:get (post-subscribe), it has already finished.
          return makeState({ threads: [thread], running: stateGetCount === 1 ? [thread.id] : [] })
        }
        if (channel === 'thread:items') {
          return [...items]
        }
        throw new Error(`Unexpected RPC: ${channel}`)
      },
      onSubscribe: () => {
        // Turn completes before subscribe() finishes, so live events were already missed.
        items.push(
          { id: 'a1', kind: 'assistant', text: 'finished in race window' },
          { id: 'r1', kind: 'result', isError: true, durationMs: 5 }
        )
      }
    })

    const buf = createIo()
    const code = await runWatchCommand(mock.runtime, buf.io, [thread.id], { format: 'text', quiet: true })

    expect(code).toBe(EXIT_ERROR)
    expect(buf.out()).toBe('finished in race window\n')
    expect(stateGetCount).toBeGreaterThanOrEqual(2)
  })

  it('continues watching across queued turns and transient dispatchHead idle state, then fetches final items', async () => {
    const thread = makeThread('thr-watch-q')
    let running: string[] = [thread.id]
    let queued: Record<string, MessageQueue> = {
      [thread.id]: {
        items: [{ id: 'q-next', prompt: 'turn 2', attachments: [], model: 'auto', mode: 'agent', force: false, createdAt: 2 }]
      }
    }
    const items: Item[] = [{ id: 'u1', kind: 'user', text: 'turn 1', createdAt: 1 }]
    const snapshot = (): AppState => makeState({ threads: [thread], running: [...running], queued: { ...queued } })

    const mock = createMockRuntime({
      call: (channel) => {
        if (channel === 'state:get') return snapshot()
        if (channel === 'thread:items') return [...items]
        throw new Error(`Unexpected RPC: ${channel}`)
      },
      onSubscribe: () => {
        // Turn 1 ends while q-next is queued.
        setTimeout(() => {
          items.push(
            { id: 'a1', kind: 'assistant', text: 'first ' },
            { id: 'r1', kind: 'result', isError: false, durationMs: 10 }
          )
          running = []
          mock.emitEvent({ type: 'items', threadId: thread.id, items: [...items] })
          mock.emitEvent({ type: 'running', threadId: thread.id, running: false })
          mock.emitState(snapshot())
        }, 15)

        // dispatchHead pops q-next with transient idle broadcast before Turn 2 starts.
        setTimeout(() => {
          queued = {}
          mock.emitState(snapshot())
        }, 25)

        // Turn 2 starts and ends; final item only persisted in store (fetched via final thread:items).
        setTimeout(() => {
          items.push({ id: 'u2', kind: 'user', text: 'turn 2', createdAt: 3 })
          running = [thread.id]
          mock.emitEvent({ type: 'running', threadId: thread.id, running: true })
          mock.emitState(snapshot())
        }, 40)

        setTimeout(() => {
          items.push(
            { id: 'a2', kind: 'assistant', text: 'second' },
            { id: 'r2', kind: 'result', isError: false, durationMs: 20 }
          )
          running = []
          mock.emitEvent({ type: 'running', threadId: thread.id, running: false })
          mock.emitState(snapshot())
        }, 55)
      }
    })

    const buf = createIo()
    const code = await runWatchCommand(mock.runtime, buf.io, [thread.id], { format: 'text', quiet: true })

    expect(code).toBe(EXIT_OK)
    expect(buf.out()).toBe('first second\n')
  })
})
