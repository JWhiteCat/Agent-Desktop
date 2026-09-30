import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import { displayThreadTitle } from '../src/shared/thread-title'
import type { ThreadMeta } from '../src/shared/types'
import { scanCliSessions } from '../src/main/history'
import { scanCodexSessions } from '../src/main/codex-history'
import { scanClaudeSessions } from '../src/main/claude-history'
import { cliHandlers } from '../src/main/ipc/cli'
import { threadHandlers } from '../src/main/ipc/threads'
import { usageHandlers } from '../src/main/ipc/usage'
import type { IpcDeps } from '../src/main/ipc/deps'
import { resolveCli, spawnCli } from '../src/main/cli'
import { SessionManager } from '../src/main/sessions'
import { Store } from '../src/main/store'
import { forkThread, syncFromCli } from '../src/main/thread-history'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }))
vi.mock('../src/main/skills', () => ({ syncAllManagedSkills: vi.fn() }))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(),
  resolveCli: vi.fn(),
  resolveApiKey: vi.fn(() => 'test-key'),
  spawnCli: vi.fn(() => { throw new Error('Test process launch stopped') })
}))

describe('automatic conversation titles', () => {
  let store: Store
  let projectId: string
  let deps: IpcDeps
  const model = 'composer-2.5[fast=true]'

  beforeEach(() => {
    vi.clearAllMocks()
    electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-title-'))
    vi.spyOn(os, 'homedir').mockReturnValue(electron.userData)
    vi.stubEnv('CODEX_HOME', path.join(electron.userData, '.codex'))
    setLanguage('zh-CN')
    store = new Store()
    projectId = store.addProject(electron.userData).id
    deps = {
      store, sessions: { isRunning: () => false, dispose: vi.fn() },
      modelsCache: new Map(), broadcast: vi.fn()
    } as unknown as IpcDeps
    vi.mocked(resolveCli).mockReturnValue(undefined)
  })

  afterEach(() => {
    store.flush()
    const directory = path.resolve(electron.userData)
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('agent-desktop-title-')) {
      throw new Error(`Unexpected test directory: ${directory}`)
    }
    fs.rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    setLanguage('system', 'zh-CN')
  })

  function create(): ThreadMeta {
    return threadHandlers(deps)['thread:create'](projectId, 'agent', model, false, 'cursor') as ThreadMeta
  }

  function write(relativePath: string, value: string): string {
    const file = path.join(electron.userData, relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value)
    return file
  }

  function jsonl(rows: unknown[]): string {
    return rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  }

  function historyFixtures(): void {
    for (const named of [false, true]) {
      const suffix = named ? 'named' : 'missing'
      write(`.cursor/chats/workspace/cursor-${suffix}/meta.json`, JSON.stringify({
        cwd: electron.userData, ...(named ? { title: '未命名会话' } : {})
      }))
      write(`.codex/sessions/rollout-codex-${suffix}.jsonl`, jsonl([
        { type: 'session_meta', payload: { id: `codex-${suffix}`, cwd: electron.userData } },
        ...(named ? [{ type: 'response_item', payload: { type: 'message', role: 'user', content: '未命名会话' } }] : [])
      ]))
      write(`.claude/projects/workspace/claude-${suffix}.jsonl`, jsonl([
        { type: 'system', sessionId: `claude-${suffix}`, cwd: electron.userData },
        ...(named ? [{ type: 'user', message: { content: '未命名会话' } }] : [])
      ]))
    }
  }

  it('localizes explicitly marked placeholders while leaving identical user and legacy titles intact', () => {
    setLanguage('en')
    expect(displayThreadTitle({ title: '新对话', titleKind: 'default' })).toBe('New conversation')
    expect(displayThreadTitle({ title: '未命名会话', titleKind: 'untitled' })).toBe('Untitled session')
    expect(displayThreadTitle({ title: '新对话' })).toBe('新对话')
    expect(displayThreadTitle({ title: '未命名会话' })).toBe('未命名会话')
    expect(displayThreadTitle({ title: 'My {title}' })).toBe('My {title}')
  })

  it('keeps a new failed conversation localizable after restart and clears its marker on explicit rename', async () => {
    const thread = create()
    const manager = new SessionManager(store, vi.fn(), vi.fn(), vi.fn())
    await expect(manager.send({ threadId: thread.id, prompt: 'Task', model, mode: 'agent', force: false })).rejects.toThrow()
    expect(spawnCli).not.toHaveBeenCalled()
    store.flush()
    const reloaded = new Store()
    setLanguage('en')
    expect(displayThreadTitle(reloaded.thread(thread.id)!)).toBe('New conversation')

    threadHandlers(deps)['thread:update'](thread.id, { title: '新对话' })
    expect(store.thread(thread.id)?.titleKind).toBeUndefined()
    expect(displayThreadTitle(store.thread(thread.id)!)).toBe('新对话')
    store.flush()
    expect(new Store().thread(thread.id)?.titleKind).toBeUndefined()
  })

  it('generates a title from the first submitted message only for marked placeholders', async () => {
    vi.mocked(resolveCli).mockReturnValue({ command: 'test-agent', prefixArgs: [] })
    const manager = new SessionManager(store, vi.fn(), vi.fn(), vi.fn())
    const generated = create()
    const literal = create()
    threadHandlers(deps)['thread:update'](literal.id, { title: '新对话' })
    for (const thread of [generated, literal]) {
      await expect(manager.send({ threadId: thread.id, prompt: 'First task\nDetails', model, mode: 'agent', force: false }))
        .rejects.toThrow('Test process launch stopped')
    }
    expect(store.thread(generated.id)).toMatchObject({ title: 'First task' })
    expect(store.thread(generated.id)?.titleKind).toBeUndefined()
    expect(store.thread(literal.id)).toMatchObject({ title: '新对话' })
  })

  it('marks missing titles in all CLI scanners without marking actual titles matching the placeholder', () => {
    historyFixtures()
    const sessions = [...scanCliSessions(new Set()), ...scanCodexSessions(new Set()), ...scanClaudeSessions(new Set())]
    expect(sessions).toHaveLength(6)
    for (const session of sessions) {
      expect(session.title).toBe('未命名会话')
      expect(session.titleKind).toBe(session.chatId.endsWith('missing') ? 'untitled' : undefined)
    }
  })

  it('persists the missing-title marker during import and forwards it through usage reports', () => {
    historyFixtures()
    expect(cliHandlers(deps)['cli:import'](['cursor-missing', 'codex-missing', 'claude-missing'])).toBe(3)
    store.flush()
    const reloaded = new Store()
    setLanguage('en')
    for (const thread of reloaded.threads) {
      expect(thread.titleKind).toBe('untitled')
      expect(displayThreadTitle(thread)).toBe('Untitled session')
    }
    const report = usageHandlers(deps)['usage:summary']('7d')
    expect(report.sessions).toHaveLength(3)
    for (const row of report.sessions) expect(displayThreadTitle(row)).toBe('Untitled session')
  })

  it('replaces a marked imported title when history gains a user message but preserves a user rename', () => {
    historyFixtures()
    cliHandlers(deps)['cli:import'](['codex-missing'])
    const thread = store.threads[0]
    const file = path.join(electron.userData, '.codex/sessions/rollout-codex-missing.jsonl')
    fs.appendFileSync(file, jsonl([{ type: 'response_item', payload: { type: 'message', role: 'user', content: 'Imported task' } }]))
    syncFromCli({ store, isRunning: () => false }, thread.id)
    expect(thread.title).toBe('Imported task')
    expect(thread.titleKind).toBeUndefined()

    threadHandlers(deps)['thread:update'](thread.id, { title: '未命名会话' })
    syncFromCli({ store, isRunning: () => false }, thread.id)
    expect(thread.title).toBe('未命名会话')
    expect(thread.titleKind).toBeUndefined()
  })

  it('rejects empty forks and keeps derived fork names literal', async () => {
    const thread = create()
    const history = { store, isRunning: () => false, forkSession: vi.fn(), broadcast: vi.fn() }
    await expect(forkThread(history, thread.id)).rejects.toThrow()
    threadHandlers(deps)['thread:update'](thread.id, { title: '新对话' })
    store.setItems(thread.id, [{ id: 'first', kind: 'user', text: 'Task', createdAt: 1 }])
    const fork = await forkThread(history, thread.id)
    setLanguage('en')
    expect(fork.thread.titleKind).toBeUndefined()
    expect(displayThreadTitle(fork.thread)).toBe('(1) 新对话')
  })
})
