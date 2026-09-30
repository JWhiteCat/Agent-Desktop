import { execFileSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type CliProvider, type Item, type ThreadMeta } from '../src/shared/types'
import type { Store } from '../src/main/store'
import { spawnCli } from '../src/main/cli'
import { spawnClaudeAcp } from '../src/main/claude'
import { spawnCodexAcp } from '../src/main/codex'
import { SessionManager } from '../src/main/sessions'
import { worktreePathFrom } from '../src/main/session/provider'

vi.mock('../src/main/skills', () => ({ syncAllManagedSkills: vi.fn() }))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(),
  resolveCli: vi.fn(() => ({ command: 'mock-agent', prefixArgs: [] })),
  resolveApiKey: vi.fn(() => ''),
  spawnCli: vi.fn(),
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

let root: string

beforeEach(() => {
  vi.clearAllMocks()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-worktree-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function fakeChild(calls: Array<{ method: string; params: any }>, stdout: PassThrough): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    exitCode: null,
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(chunk.toString())
        calls.push({ method: message.method, params: message.params })
        const result = message.method === 'session/new'
          ? { sessionId: 'new-session' }
          : message.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
        callback()
      }
    })
  }) as unknown as ChildProcess
}

function setup(provider: CliProvider = 'cursor') {
  const project = path.join(root, 'project')
  const worktree = path.join(root, 'worktrees', 'project', 'master-abc')
  fs.mkdirSync(project)
  fs.mkdirSync(worktree, { recursive: true })
  const calls: Array<{ method: string; params: any }> = []
  const stdout = new PassThrough()
  const child = fakeChild(calls, stdout)
  vi.mocked(spawnCli).mockImplementation(() => {
    stdout.write(`Using worktree: ${worktree}\r\n`)
    return child
  })
  vi.mocked(spawnCodexAcp).mockReturnValue(child)
  vi.mocked(spawnClaudeAcp).mockReturnValue(child)
  const thread = { id: 'thread', projectId: 'project', cli: provider, mode: 'agent' } as ThreadMeta
  const items: Item[] = []
  const dataDir = path.join(root, 'data')
  const store = {
    settings: { ...DEFAULT_SETTINGS, codexApiKey: 'key', claudeApiKey: 'key' },
    dataDir,
    thread: () => thread,
    project: () => ({ id: 'project', path: project }),
    items: () => items,
    markItemsDirty: vi.fn(),
    updateThread: (_id: string, patch: Partial<ThreadMeta>) => Object.assign(thread, patch)
  }
  const finished = vi.fn()
  const manager = new SessionManager(store as unknown as Store, vi.fn(), vi.fn(), finished, vi.fn(async () => undefined) as any, vi.fn(async () => undefined) as any)
  const send = async (prompt: string, worktree = true) => {
    const count = finished.mock.calls.length
    await manager.send({ threadId: 'thread', prompt, model: 'auto', mode: 'agent', force: false, worktree })
    await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(count + 1))
  }
  return { manager, send, calls, thread, project, worktree, dataDir }
}

function gitRepo(dir: string): void {
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  run('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
  run('add', '.')
  run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
}

describe('Cursor worktree conversations', () => {
  it('reads the worktree path the CLI prints', () => {
    expect(worktreePathFrom('Using worktree: C:\\Users\\me\\.cursor\\worktrees\\repo\\master-d36\r')).toBe('C:\\Users\\me\\.cursor\\worktrees\\repo\\master-d36')
    expect(worktreePathFrom('{"jsonrpc":"2.0"}')).toBeUndefined()
  })

  it('starts the session in the worktree and keeps using it', async () => {
    const ctx = setup()
    try {
      await ctx.send('first')
      const args = vi.mocked(spawnCli).mock.calls[0][1]
      expect(args).toContain('--worktree')
      expect(args[args.indexOf('--workspace') + 1]).toBe(ctx.project)
      expect(ctx.calls.find((c) => c.method === 'session/new')?.params.cwd).toBe(ctx.worktree)
      expect(ctx.thread).toMatchObject({ chatId: 'new-session', cwd: ctx.worktree, worktree: true })

      await ctx.send('second')
      expect(spawnCli).toHaveBeenCalledTimes(1)
      expect(ctx.calls.filter((c) => c.method === 'session/prompt')).toHaveLength(2)
    } finally {
      ctx.manager.stopAll()
    }
  })

  it('resumes a saved worktree conversation inside the worktree', async () => {
    const ctx = setup()
    Object.assign(ctx.thread, { chatId: 'new-session', cwd: ctx.worktree, worktree: true })
    try {
      await ctx.send('again')
      const args = vi.mocked(spawnCli).mock.calls[0][1]
      expect(args).not.toContain('--worktree')
      expect(args[args.indexOf('--workspace') + 1]).toBe(ctx.worktree)
      expect(ctx.calls.find((c) => c.method === 'session/load')?.params.cwd).toBe(ctx.worktree)
    } finally {
      ctx.manager.stopAll()
    }
  })
})

describe.each(['codex', 'claude'] as const)('%s worktree conversations', (provider) => {
  const spawned = () => vi.mocked(provider === 'codex' ? spawnCodexAcp : spawnClaudeAcp)

  it('creates a git worktree on a new branch and starts the session there', async () => {
    const ctx = setup(provider)
    gitRepo(ctx.project)
    try {
      await ctx.send('first')
      const cwd = ctx.thread.cwd!
      expect(path.dirname(path.dirname(cwd))).toBe(path.join(ctx.dataDir, 'worktrees'))
      expect(path.basename(cwd)).toMatch(/^main-[0-9a-f]{8}$/)
      expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('a')
      expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).toString().trim()).toBe(`agent-desktop/${path.basename(cwd)}`)
      expect(spawned().mock.calls[0][1]).toBe(cwd)
      expect(ctx.calls.find((c) => c.method === 'session/new')?.params.cwd).toBe(cwd)
      expect(ctx.thread).toMatchObject({ chatId: 'new-session', worktree: true })

      await ctx.send('second', false)
      expect(spawned()).toHaveBeenCalledTimes(1)
      expect(ctx.thread).toMatchObject({ cwd, worktree: true })
    } finally {
      ctx.manager.stopAll()
    }
  })

  it('does not start the CLI when the project is not a git repository', async () => {
    const ctx = setup(provider)
    try {
      await expect(ctx.manager.send({ threadId: 'thread', prompt: 'x', model: 'auto', mode: 'agent', force: false, worktree: true }))
        .rejects.toThrow('worktree')
      expect(spawned()).not.toHaveBeenCalled()
      expect(ctx.thread.cwd).toBeUndefined()
    } finally {
      ctx.manager.stopAll()
    }
  })

  it('stays in the project directory without the worktree switch', async () => {
    const ctx = setup(provider)
    try {
      await ctx.send('first', false)
      expect(spawned().mock.calls[0][1]).toBe(ctx.project)
      expect(ctx.thread).toMatchObject({ cwd: ctx.project, worktree: false })
    } finally {
      ctx.manager.stopAll()
    }
  })
})
