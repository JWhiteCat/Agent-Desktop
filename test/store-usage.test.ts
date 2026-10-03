import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliProvider, Item, ResultItem } from '../src/shared/types'
import type { CodexUsageTurn } from '../src/main/codex-usage'
import { Store } from '../src/main/store'

const electron = vi.hoisted(() => ({ userData: '' }))
const codex = vi.hoisted(() => ({ readUsage: vi.fn() }))
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData' || !electron.userData) throw new Error(`Unexpected app path: ${name}`)
      return electron.userData
    }
  }
}))
vi.mock('../src/main/codex-history', () => ({ readCodexUsage: codex.readUsage, repairCodexMcpTools: vi.fn(() => false) }))

const now = 1_700_000_000_000

function rollout(): CodexUsageTurn {
  return {
    usageId: 'codex:completed-turn',
    turnId: 'completed-turn',
    startedAt: now + 1_000,
    createdAt: now + 30_000,
    model: 'gpt-5.4',
    usage: {
      inputTokens: 1_000,
      outputTokens: 100,
      requests: [{ inputTokens: 400, outputTokens: 40 }, { inputTokens: 600, outputTokens: 60 }]
    },
    isError: false,
    completed: true,
    endLine: 10
  }
}

function transcript(patch: Partial<ResultItem> = {}): Item[] {
  return [
    { id: 'user', kind: 'user', text: 'Keep this question.', createdAt: now },
    { id: 'assistant', kind: 'assistant', text: 'Keep this answer.' },
    {
      id: 'result',
      kind: 'result',
      isError: false,
      createdAt: now + 31_000,
      model: 'gpt-5.4[reasoning_effort=high]',
      durationMs: 31_000,
      usageId: 'legacy-random-id',
      usage: { inputTokens: 600, outputTokens: 60 },
      quotaUsage: { weekly: 0.5, fiveHour: 2 },
      ...patch
    }
  ]
}

describe('stored Codex usage repair', () => {
  let store: Store
  let projectId: string

  beforeEach(() => {
    electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-store-usage-'))
    codex.readUsage.mockReset()
    store = new Store()
    projectId = store.addProject(electron.userData, 'Usage regression').id
  })

  afterEach(() => {
    store?.flush()
    const dir = path.resolve(electron.userData)
    const tempRoot = path.resolve(os.tmpdir())
    if (path.dirname(dir) !== tempRoot || !path.basename(dir).startsWith('agent-desktop-store-usage-')) {
      throw new Error(`Refusing to remove unexpected test directory: ${dir}`)
    }
    fs.rmSync(dir, { recursive: true, force: true })
    electron.userData = ''
  })

  function addThread(id: string, items: Item[], cli: CliProvider = 'codex'): void {
    store.createThread({ id, projectId, title: id, chatId: `${id}-chat`, cli, mode: 'agent', source: 'app' })
    store.setItems(id, items)
  }

  function reload(): void {
    store.flush()
    store = new Store()
  }

  it('repairs a saved result on load and updates a fork sharing its old usage ID', () => {
    const sourceItems = transcript()
    const forkItems = transcript({ id: 'fork-result' })
    addThread('source', sourceItems)
    addThread('fork', forkItems)
    reload()
    const turn = rollout()
    codex.readUsage.mockImplementation((chatId: string) => chatId === 'source-chat' ? [turn] : undefined)

    const source = store.items('source')
    const fork = store.items('fork')
    expect(codex.readUsage).toHaveBeenCalledExactlyOnceWith('source-chat')
    expect(source.slice(0, 2)).toEqual(sourceItems.slice(0, 2))
    expect(fork.slice(0, 2)).toEqual(forkItems.slice(0, 2))
    expect(source[2]).toEqual({ ...sourceItems[2], cli: 'codex', usageId: turn.usageId, usage: turn.usage, usageComplete: true })
    expect(fork[2]).toEqual({ ...forkItems[2], cli: 'codex', usageId: turn.usageId, usage: turn.usage, usageComplete: true })

    reload()
    codex.readUsage.mockClear()
    expect(store.items('source')).toEqual(source)
    expect(store.items('fork')).toEqual(fork)
    expect(codex.readUsage).not.toHaveBeenCalled()
  })

  it('finishes partial request usage and propagates it when the usage ID stays the same', () => {
    const turn = rollout()
    const partial: Partial<ResultItem> = {
      cli: 'codex',
      usageId: turn.usageId,
      usageComplete: false,
      usage: { inputTokens: 400, outputTokens: 40, requests: [{ inputTokens: 400, outputTokens: 40 }] }
    }
    addThread('source', transcript(partial))
    addThread('fork', transcript({ ...partial, id: 'fork-result' }))
    reload()
    // The fork is already cached before the source log finishes.
    codex.readUsage.mockReturnValue(undefined)
    const fork = store.items('fork')
    codex.readUsage.mockImplementation((chatId: string) => chatId === 'source-chat' ? [turn] : undefined)

    const source = store.items('source')
    expect(source[2]).toMatchObject({ usage: turn.usage, usageComplete: true })
    expect(fork[2]).toMatchObject({ id: 'fork-result', usage: turn.usage, usageComplete: true })
    reload()
    expect(store.items('fork')[2]).toMatchObject({ usage: turn.usage, usageComplete: true })
  })

  it.each([false, true])('preserves split plan history when copying repaired usage (split source: %s)', (splitSource) => {
    const plan = rollout()
    const implementation: CodexUsageTurn = {
      ...rollout(), usageId: 'codex:implementation', turnId: 'implementation',
      startedAt: now + 30_170, createdAt: now + 90_000
    }
    const combined: CodexUsageTurn = {
      ...plan, createdAt: implementation.createdAt,
      usage: {
        inputTokens: 2_000, outputTokens: 200,
        requests: [...plan.usage.requests!, ...implementation.usage.requests!]
      },
      componentTurns: [plan, implementation]
    }
    const joinedItems = transcript({
      createdAt: now + 91_000, cli: 'codex', usageId: plan.usageId,
      usage: plan.usage, usageComplete: false
    })
    const splitItems: Item[] = [
      ...transcript({ createdAt: plan.createdAt, cli: 'codex', usageId: plan.usageId, usage: plan.usage }),
      { id: 'implementation-user', kind: 'user', text: 'Implement the approved plan.', createdAt: now + 30_250 },
      {
        id: 'implementation-result', kind: 'result', cli: 'codex', isError: false,
        createdAt: implementation.createdAt, usageId: implementation.usageId, usage: implementation.usage
      }
    ]
    addThread('joined', joinedItems)
    addThread('split', splitItems)
    reload()
    codex.readUsage.mockReturnValue([combined])

    store.items(splitSource ? 'split' : 'joined')
    const joined = store.items('joined').filter((item) => item.kind === 'result')
    const split = store.items('split').filter((item) => item.kind === 'result')
    expect(joined).toHaveLength(1)
    expect(joined[0].usage).toEqual(combined.usage)
    expect(split).toHaveLength(2)
    expect(split.map((item) => item.usage)).toEqual([plan.usage, implementation.usage])
    expect(split.reduce((sum, item) => sum + item.usage!.inputTokens!, 0)).toBe(2_000)
    reload()
    expect(store.items('split').filter((item) => item.kind === 'result').map((item) => item.usage)).toEqual([plan.usage, implementation.usage])
  })

  it('preserves fixed weekly estimates across restarts and usage repair', () => {
    const weeklyQuotaEstimate = {
      start: { sampledAt: now, weekly: { usedPercent: 37, resetsAt: now + 604_800_000 } },
      end: { sampledAt: now + 30_000, weekly: { usedPercent: 37.5, resetsAt: now + 604_800_000 } },
      usedPercent: 0.5
    }
    addThread('source', transcript({ weeklyQuotaEstimate }))
    addThread('fork', transcript({ id: 'fork-result', weeklyQuotaEstimate }))
    addThread('missing', transcript({ weeklyQuotaEstimate: {} }))
    reload()
    const turn = rollout()
    turn.quotaSnapshot = { sampledAt: now + 60_000, weekly: { usedPercent: 99 } }
    codex.readUsage.mockImplementation((chatId: string) => chatId === 'source-chat' ? [turn] : undefined)
    expect(store.items('source')[2]).toMatchObject({ weeklyQuotaEstimate, quotaSnapshot: turn.quotaSnapshot, usage: turn.usage })
    expect(store.items('fork')[2]).toMatchObject({ weeklyQuotaEstimate, usage: turn.usage })
    expect(store.items('missing')[2]).toHaveProperty('weeklyQuotaEstimate', {})
    reload()
    expect(store.items('source')[2]).toHaveProperty('weeklyQuotaEstimate', weeklyQuotaEstimate)
    expect(store.items('fork')[2]).toHaveProperty('weeklyQuotaEstimate', weeklyQuotaEstimate)
    expect(store.items('missing')[2]).toHaveProperty('weeklyQuotaEstimate', {})
  })

  it('restores missing quota for an already complete token record and its fork', () => {
    const turn = rollout()
    turn.quotaSnapshot = { sampledAt: now + 29_000, weekly: { usedPercent: 37 } }
    const saved: Partial<ResultItem> = {
      cli: 'codex', usageId: turn.usageId, usage: turn.usage, usageComplete: true, quotaUsage: undefined
    }
    addThread('source', transcript(saved))
    addThread('fork', transcript({ ...saved, id: 'fork-result' }))
    reload()
    codex.readUsage.mockImplementation((chatId: string) => chatId === 'source-chat' ? [turn] : undefined)
    expect(store.items('source')[2]).toMatchObject({ quotaSnapshot: turn.quotaSnapshot })
    expect(store.items('fork')[2]).toMatchObject({ quotaSnapshot: turn.quotaSnapshot })
    reload()
    codex.readUsage.mockClear()
    expect(store.items('source')[2]).toMatchObject({ quotaSnapshot: turn.quotaSnapshot })
    expect(codex.readUsage).not.toHaveBeenCalled()
  })

  it.each(['cursor', 'codex'] as const)('stamps legacy results as %s before switching the thread CLI', (cli) => {
    const items = transcript()
    items.push({ id: 'tagged-result', kind: 'result', isError: false, cli: 'claude', usage: { inputTokens: 7 } })
    addThread('switch', items, cli)
    reload()
    codex.readUsage.mockReturnValue(undefined)

    store.updateThread('switch', { cli: cli === 'codex' ? 'cursor' : 'codex' })

    expect(store.items('switch')[2]).toEqual({ ...items[2], cli })
    expect(store.items('switch')[3]).toEqual(items[3])
    expect(store.thread('switch')?.chatId).toBeUndefined()
    reload()
    expect(store.items('switch')[2]).toMatchObject({ cli })
    expect(store.items('switch')[3]).toMatchObject({ cli: 'claude' })
  })
})
