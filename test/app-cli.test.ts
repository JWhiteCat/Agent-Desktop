import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AppState, type Item, type Project, type QuestionItem, type SendRequest, type ThreadMeta } from '@shared/types'
import { parseArgs } from '../src/cli/args'
import { runCli } from '../src/cli/index'
import { StreamRenderer } from '../src/cli/stream-render'
import {
  EXIT_CONFLICT,
  EXIT_NOT_ATTACHED,
  EXIT_OK,
  EXIT_QUESTION_REQUIRED,
  EXIT_USAGE,
  type CliIo
} from '../src/cli/types'
import { handlersForLocalCli, LocalControlServer } from '../src/main/local-control'

function createBufferIo(cwd: string, stdinText = ''): { io: CliIo; out: () => string; err: () => string } {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const stdin = Readable.from(stdinText ? [Buffer.from(stdinText, 'utf8')] : []) as Readable & { isTTY?: boolean }
  stdin.isTTY = false
  return {
    io: {
      stdout: { write: (chunk: string) => { stdoutChunks.push(chunk); return true }, isTTY: false },
      stderr: { write: (chunk: string) => { stderrChunks.push(chunk); return true }, isTTY: false },
      stdin,
      cwd: () => cwd,
      env: { ...process.env }
    },
    out: () => stdoutChunks.join(''),
    err: () => stderrChunks.join('')
  }
}

describe('CLI argument parser and stream renderer', () => {
  it('parses flags, aliases, repeatable options, negatable booleans, and -- passthrough', () => {
    const parsed = parseArgs(
      ['run', '--cli=codex', '-m', 'gpt-5', '--no-force', '-f', 'a.png', '-f', 'b.txt', '--', '--literal-prompt'],
      {
        cli: { type: 'string' },
        model: { type: 'string', alias: 'm' },
        force: { type: 'boolean', negatable: true },
        file: { type: 'string[]', alias: 'f' }
      }
    )
    expect(parsed.positionals).toEqual(['run', '--literal-prompt'])
    expect(parsed.flags).toEqual({
      cli: 'codex',
      model: 'gpt-5',
      force: false,
      file: ['a.png', 'b.txt']
    })
  })

  it('streams assistant deltas incrementally without duplication in text and jsonl modes', () => {
    const textBuf = createBufferIo(process.cwd())
    const textRenderer = new StreamRenderer({ format: 'text', io: textBuf.io, baselineIds: ['old-1'] })
    textRenderer.onItems([
      { id: 'old-1', kind: 'assistant', text: 'previous turn' },
      { id: 'a1', kind: 'assistant', text: 'Hello ' }
    ])
    textRenderer.onItems([
      { id: 'old-1', kind: 'assistant', text: 'previous turn' },
      { id: 'a1', kind: 'assistant', text: 'Hello world!' },
      { id: 't1', kind: 'tool', callId: 'c1', tool: 'read_file', args: { path: 'README.md' }, status: 'running', startedAt: 1 }
    ])
    textRenderer.onItems([
      { id: 'old-1', kind: 'assistant', text: 'previous turn' },
      { id: 'a1', kind: 'assistant', text: 'Hello world!' },
      { id: 't1', kind: 'tool', callId: 'c1', tool: 'read_file', args: { path: 'README.md' }, status: 'success', startedAt: 1, endedAt: 2 },
      { id: 'r1', kind: 'result', isError: false, durationMs: 1200, fileChanges: [{ path: 'README.md', diff: '' }] }
    ])
    textRenderer.finishTextSummary()
    expect(textBuf.out()).toBe('Hello world!\n')
    expect(textBuf.err()).toContain('[tool:running] read_file README.md')
    expect(textBuf.err()).toContain('[tool:success] read_file README.md')
    expect(textBuf.err()).toContain('[done] 1.2s · 1 file changed')

    const jsonlBuf = createBufferIo(process.cwd())
    const jsonlRenderer = new StreamRenderer({ format: 'jsonl', io: jsonlBuf.io })
    jsonlRenderer.onItems([{ id: 'a1', kind: 'assistant', text: 'Hi' }])
    jsonlRenderer.onItems([{ id: 'a1', kind: 'assistant', text: 'Hi there' }])
    const lines = jsonlBuf.out().trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { type: 'assistant.delta', itemId: 'a1', delta: 'Hi' },
      { type: 'assistant.delta', itemId: 'a1', delta: ' there' }
    ])
  })
})

describe('CLI end-to-end (attached and headless)', () => {
  let userDataDir: string
  let dataDir: string
  let projectDir: string
  let server: LocalControlServer

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-cli-e2e-'))
    dataDir = path.join(userDataDir, 'data')
    projectDir = path.join(userDataDir, 'sample-project')
    fs.mkdirSync(projectDir, { recursive: true })
    server = new LocalControlServer()
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(userDataDir, { recursive: true, force: true })
  })

  it('controls a running desktop control server across projects, threads, run, question/answer, and stop', async () => {
    const projects: Project[] = []
    const threads: ThreadMeta[] = []
    const itemsByThread = new Map<string, Item[]>()
    const running = new Set<string>()
    const waiting = new Set<string>()
    const answeredQuestions: Array<{ threadId: string; questionId: string; answers: unknown }> = []
    const stoppedThreads: string[] = []

    const snapshot = (): AppState => ({
      systemLocale: 'en-US',
      projects,
      threads,
      settings: { ...DEFAULT_SETTINGS },
      running: [...running],
      starting: [],
      waitingForInput: [...waiting],
      queued: {}
    })

    const handlers = handlersForLocalCli({
      'state:get': () => snapshot(),
      'cli:info': (provider: string) => ({ found: provider === 'cursor', path: '/bin/agent', version: '1.0.0', authStatus: 'authenticated' }),
      'project:add': (dir: string) => {
        const existing = projects.find((p) => p.path === dir)
        if (existing) return existing
        const p: Project = { id: `proj-${projects.length + 1}`, name: path.basename(dir), path: dir, createdAt: Date.now() }
        projects.push(p)
        return p
      },
      'thread:create': (projectId: string, mode: ThreadMeta['mode'], model: string, force: boolean, cli: ThreadMeta['cli']) => {
        const t: ThreadMeta = {
          id: `thr-${threads.length + 1}`,
          projectId,
          title: '新对话',
          mode,
          model,
          force,
          cli,
          source: 'app',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        threads.push(t)
        itemsByThread.set(t.id, [])
        return t
      },
      'thread:items': (id: string) => itemsByThread.get(id) ?? [],
      'thread:delete': (id: string) => {
        const idx = threads.findIndex((t) => t.id === id)
        if (idx >= 0) threads.splice(idx, 1)
      },
      'agent:send': (req: SendRequest) => {
        const list = itemsByThread.get(req.threadId) ?? []
        list.push({ id: `u-${list.length + 1}`, kind: 'user', text: req.prompt, createdAt: Date.now() })
        itemsByThread.set(req.threadId, list)
        running.add(req.threadId)
        server.broadcast('agent:event', { type: 'running', threadId: req.threadId, running: true })

        if (req.prompt.includes('ASK_QUESTION')) {
          setTimeout(() => {
            waiting.add(req.threadId)
            const q: QuestionItem = {
              id: 'q-1',
              kind: 'question',
              toolCallId: 'tc-1',
              title: 'Choose target',
              questions: [{ id: 'target', prompt: 'Pick one', options: [{ id: 'opt1', label: 'Option 1' }] }],
              status: 'pending'
            }
            list.push(q)
            server.broadcast('agent:event', { type: 'items', threadId: req.threadId, items: [...list] })
          }, 15)
          return
        }

        setTimeout(() => {
          list.push({ id: `a-${list.length + 1}`, kind: 'assistant', text: `Echo: ${req.prompt}` })
          server.broadcast('agent:event', { type: 'items', threadId: req.threadId, items: [...list] })
        }, 15)
        setTimeout(() => {
          list.push({ id: `r-${list.length + 1}`, kind: 'result', isError: false, durationMs: 42 })
          running.delete(req.threadId)
          server.broadcast('agent:event', { type: 'items', threadId: req.threadId, items: [...list] })
          server.broadcast('agent:event', { type: 'running', threadId: req.threadId, running: false })
          server.broadcast('state:changed', snapshot())
        }, 30)
      },
      'agent:stop': (id: string) => {
        stoppedThreads.push(id)
        running.delete(id)
        waiting.delete(id)
        server.broadcast('agent:event', { type: 'running', threadId: id, running: false })
        server.broadcast('state:changed', snapshot())
      },
      'agent:answerQuestion': (threadId: string, questionId: string, answers: unknown) => {
        answeredQuestions.push({ threadId, questionId, answers })
        waiting.delete(threadId)
      }
    }, snapshot)

    await server.start({ dataDir, appVersion: '0.1.0-e2e', handlers })

    // 1. Status attaches to the running desktop server.
    const statusIo = createBufferIo(projectDir)
    expect(await runCli(['status', '--user-data', userDataDir, '--json'], { io: statusIo.io })).toBe(EXIT_OK)
    const statusJson = JSON.parse(statusIo.out())
    expect(statusJson.mode).toBe('attached')
    expect(statusJson.desktopPid).toBe(process.pid)

    // 2. --headless rejects while desktop is running.
    const conflictIo = createBufferIo(projectDir)
    expect(await runCli(['status', '--user-data', userDataDir, '--headless', '--json'], { io: conflictIo.io })).toBe(EXIT_CONFLICT)

    // 3. run creates project + thread, streams reply, returns JSON result.
    const runIo = createBufferIo(projectDir)
    expect(await runCli(['run', 'hello desktop', '--user-data', userDataDir, '--json'], { io: runIo.io })).toBe(EXIT_OK)
    const runResult = JSON.parse(runIo.out())
    expect(runResult).toMatchObject({
      ok: true,
      threadId: 'thr-1',
      runtimeMode: 'attached',
      text: 'Echo: hello desktop',
      isError: false
    })

    // 4. Question in non-TTY defaults to --on-question=fail and returns EXIT_QUESTION_REQUIRED (3).
    const qIo = createBufferIo(projectDir)
    expect(await runCli(['run', 'ASK_QUESTION', '--thread', 'thr-1', '--user-data', userDataDir, '--json'], { io: qIo.io })).toBe(EXIT_QUESTION_REQUIRED)
    const qPayload = JSON.parse(qIo.out())
    expect(qPayload).toMatchObject({ ok: false, reason: 'question_required', threadId: 'thr-1', questionId: 'q-1' })

    // 5. answer + stop commands.
    const ansIo = createBufferIo(projectDir)
    expect(await runCli([
      'answer', 'thr-1', 'q-1',
      '--answers', JSON.stringify([{ questionId: 'target', selectedOptionIds: ['opt1'] }]),
      '--user-data', userDataDir, '--json'
    ], { io: ansIo.io })).toBe(EXIT_OK)
    expect(answeredQuestions).toHaveLength(1)

    const stopIo = createBufferIo(projectDir)
    expect(await runCli(['stop', 'thr-1', '--user-data', userDataDir, '--json'], { io: stopIo.io })).toBe(EXIT_OK)
    expect(stoppedThreads).toEqual(['thr-1'])
  })

  it('respects --attach-only when desktop is not running and falls back to headless otherwise', async () => {
    const attachIo = createBufferIo(projectDir)
    expect(await runCli(['status', '--user-data', userDataDir, '--attach-only', '--json'], { io: attachIo.io })).toBe(EXIT_NOT_ATTACHED)

    // Without --attach-only, headless mode registers projects & threads and persists them to disk.
    const addIo = createBufferIo(projectDir)
    expect(await runCli(['projects', 'add', '.', '--user-data', userDataDir, '--json'], { io: addIo.io })).toBe(EXIT_OK)
    const project = JSON.parse(addIo.out()) as Project
    expect(project.path).toBe(projectDir)

    const createIo = createBufferIo(projectDir)
    expect(await runCli(['threads', 'create', '--project', '.', '--cli', 'codex', '--user-data', userDataDir, '--json'], { io: createIo.io })).toBe(EXIT_OK)
    const created = JSON.parse(createIo.out()) as ThreadMeta
    expect(created.cli).toBe('codex')

    const listIo = createBufferIo(projectDir)
    expect(await runCli(['threads', 'list', '--user-data', userDataDir, '--json'], { io: listIo.io })).toBe(EXIT_OK)
    const listed = JSON.parse(listIo.out()) as Array<{ id: string; cli: string }>
    expect(listed.some((t) => t.id === created.id && t.cli === 'codex')).toBe(true)

    // --detach in headless mode is rejected with EXIT_USAGE.
    const detachIo = createBufferIo(projectDir)
    expect(await runCli(['run', 'hi', '--detach', '--user-data', userDataDir, '--json'], { io: detachIo.io })).toBe(EXIT_USAGE)
  })
})
