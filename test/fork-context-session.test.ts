import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliProvider, Item, SendRequest, ThreadMeta } from '../src/shared/types'
import type { Store } from '../src/main/store'
import { SessionManager } from '../src/main/sessions'
import { StreamReducer } from '../src/main/reducer'
import { parseForkPrompt } from '../src/main/fork-context'
import { readCodexUsage } from '../src/main/codex-history'
import type { CodexUsageTurn } from '../src/main/codex-usage'

vi.mock('../src/main/codex-history', () => ({ readCodexUsage: vi.fn() }))
vi.mock('../src/main/cli', async (original) => ({
  ...await original<typeof import('../src/main/cli')>(), killTree: vi.fn()
}))

const managers: SessionManager[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stopAll()
})

function setup(provider: CliProvider, mode: SendRequest['mode'] = 'ask') {
  const items: Item[] = [
    { id: 'copy-u', kind: 'user', text: 'Remember violet-42', createdAt: 10 },
    { id: 'copy-a', kind: 'assistant', text: 'I remember violet-42.' },
    { id: 'current-u', kind: 'user', text: 'What did I ask you to remember?', createdAt: 20 }
  ]
  const thread = { id: 'fork', title: 'Fork', chatId: 'independent-session', forkContextThroughItemId: 'copy-a' } as ThreadMeta
  const store = {
    thread: () => thread,
    items: () => items,
    markItemsDirty: vi.fn(),
    updateThread: (_id: string, patch: Partial<ThreadMeta>) => Object.assign(thread, patch)
  }
  const manager = new SessionManager(store as unknown as Store, vi.fn(), vi.fn(), vi.fn())
  managers.push(manager)
  // Context delivery must not scan real rollouts or leave a background usage poll.
  const turns: CodexUsageTurn[] = []
  vi.mocked(readCodexUsage).mockImplementation(() => turns)
  const request = vi.fn(async (_method: string, _params: { sessionId: string; prompt: Array<{ type: 'text'; text: string }> }) => {
    turns.push({
      usageId: `fork-turn-${turns.length + 1}`, startedAt: Date.now(),
      usage: {}, isError: false, completed: true, endLine: turns.length
    })
    return { stopReason: 'end_turn' }
  })
  const run = {
    proc: { provider, acp: { request }, child: { exitCode: null }, ready: true, sessionId: 'independent-session', dying: false },
    reducer: new StreamReducer(items), stopped: false, pending: new Map(), acceptUpdates: true,
    force: false, mode, switchCalls: new Set(), settled: false
  }
  const internal = manager as any
  const req: SendRequest = { threadId: 'fork', prompt: 'What did I ask you to remember?', model: 'composer-2.5[fast=true]', mode, force: false }
  const start = () => {
    run.settled = false
    internal.runs.set('fork', run)
    return internal.runPrompt('fork', run, req) as Promise<void>
  }
  return { thread, items, request, start, run, req }
}

describe('fork context delivery to the model', () => {
  it.each(['cursor', 'codex', 'claude'] as const)('sends copied %s history once and leaves the visible user message intact', async (provider) => {
    const ctx = setup(provider)
    await ctx.start()
    const text = ctx.request.mock.calls[0][1].prompt[0].text
    const replay = parseForkPrompt(text)
    expect(replay?.items.map((item) => 'text' in item ? item.text : '')).toEqual(['Remember violet-42', 'I remember violet-42.'])
    expect(replay?.prompt).toBe(ctx.req.prompt)
    expect(ctx.items[2]).toMatchObject({ kind: 'user', text: ctx.req.prompt })
    expect(ctx.thread.forkContextThroughItemId).toBeUndefined()

    ctx.req.prompt = 'Continue'
    await ctx.start()
    expect(ctx.request.mock.calls[1][1]).toEqual({ sessionId: 'independent-session', prompt: [{ type: 'text', text: 'Continue' }] })
  })

  it.each(['cursor', 'codex', 'claude'] as const)('retains replay history inside %s Plan mode instructions', async (provider) => {
    const ctx = setup(provider, 'plan')
    await ctx.start()
    const text = ctx.request.mock.calls[0][1].prompt[0].text
    expect(text).toContain('<agent_desktop_client>')
    expect(parseForkPrompt(text)?.items).toHaveLength(2)
    expect(parseForkPrompt(text)?.prompt).toBe(ctx.req.prompt)
  })

  it('keeps the persisted replay marker on failure so retry still gets the copied history', async () => {
    const ctx = setup('cursor')
    ctx.request.mockRejectedValueOnce(new Error('connection failed'))
    await expect(ctx.start()).rejects.toThrow('connection failed')
    expect(ctx.thread.forkContextThroughItemId).toBe('copy-a')
    await ctx.start()
    expect(parseForkPrompt(ctx.request.mock.calls[1][1].prompt[0].text)?.items).toHaveLength(2)
    expect(ctx.thread.forkContextThroughItemId).toBeUndefined()
  })

  it('keeps copied history pending after a cancelled prompt', async () => {
    const ctx = setup('cursor')
    ctx.request.mockResolvedValue({ stopReason: 'cancelled' })
    await ctx.start()
    expect(ctx.thread.forkContextThroughItemId).toBe('copy-a')
  })

  it('does not send an empty conversation if its copied history is missing', async () => {
    const ctx = setup('cursor')
    ctx.thread.forkContextThroughItemId = 'missing'
    await expect(ctx.start()).rejects.toThrow('分叉历史缺失')
    expect(ctx.request).not.toHaveBeenCalled()
  })
})
