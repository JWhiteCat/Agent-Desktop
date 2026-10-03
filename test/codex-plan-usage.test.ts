import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readCodexUsage, transcriptItems } from '../src/main/codex-history'
import { CodexTurnUsageReader } from '../src/main/codex-turn-usage'
import { repairCodexUsage } from '../src/main/codex-usage-repair'
import { quoteModel } from '../src/shared/model-prices'
import type { Item, ResultItem } from '../src/shared/types'

const now = Date.parse('2026-10-03T12:04:09Z')
const session = '01a10180-0e04-7d31-b89d-751bf9c86b11'
const row = (type: string, payload: object, offset = 0): string =>
  JSON.stringify({ type, payload, timestamp: new Date(now + offset).toISOString() })
const event = (type: string, payload: object, offset = 0): string => row('event_msg', { type, ...payload }, offset)
const tokens = (input: number, cached: number, output: number, offset: number): string => event('token_count', {
  info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } }
}, offset)
const header = row('session_meta', { id: session, originator: 'agent-desktop' })
const plan = [
  header,
  event('task_started', { turn_id: 'plan', collaboration_mode_kind: 'plan' }),
  row('turn_context', { turn_id: 'plan', model: 'gpt-6-astra', collaboration_mode: { mode: 'plan' } }),
  row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Make a plan.' }] }),
  tokens(854_537, 821_888, 9_549, 473_000),
  event('item_completed', { turn_id: 'plan', item: { type: 'Plan', id: 'plan-review' } }, 474_000),
  row('response_item', {
    type: 'message', role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: '<proposed_plan>Build it.</proposed_plan>' }]
  }, 474_000),
  event('task_complete', { turn_id: 'plan' }, 474_000)
]
const implementation = [
  event('task_started', { turn_id: 'implementation', collaboration_mode_kind: 'default' }, 474_170),
  row('turn_context', { turn_id: 'implementation', model: 'gpt-6-astra', collaboration_mode: { mode: 'default' } }, 474_200),
  row('response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Implement the approved plan.' }]
  }, 474_250),
  tokens(12_270_695, 11_930_112, 39_296, 2_431_000),
  event('task_complete', { turn_id: 'implementation' }, 2_431_000)
]
const fullRollout = [...plan, ...implementation].join('\n')

describe('approved Codex plan usage through rollout readers', () => {
  let root: string
  let file: string

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plan-usage-'))
    fs.mkdirSync(path.join(root, 'sessions'))
    file = path.join(root, 'sessions', `rollout-${session}.jsonl`)
    vi.stubEnv('CODEX_HOME', root)
    fs.writeFileSync(file, header)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    const resolved = path.resolve(root)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('codex-plan-usage-')) {
      throw new Error(`Refusing to remove unexpected test directory: ${resolved}`)
    }
    fs.rmSync(resolved, { recursive: true, force: true })
  })

  it('returns all plan and implementation requests for one ACP prompt', () => {
    const reader = new CodexTurnUsageReader(session)
    fs.writeFileSync(file, fullRollout)
    vi.setSystemTime(now + 2_431_500)
    const recorded = reader.read()
    expect(recorded).toMatchObject({
      usageId: 'codex:plan', startedAt: now, createdAt: now + 2_431_000, completed: true,
      usage: { inputTokens: 340_583, cacheReadTokens: 11_930_112, outputTokens: 39_296 }
    })
    expect(recorded?.usage.requests).toHaveLength(2)
    const expectedCost = [
      { inputTokens: 32_649, cacheReadTokens: 821_888, outputTokens: 9_549 },
      { inputTokens: 307_934, cacheReadTokens: 11_108_224, outputTokens: 29_747 }
    ].reduce((sum, usage) => sum + quoteModel('gpt-6-astra', usage, 'codex').costUsd!, 0)
    expect(quoteModel('gpt-6-astra', recorded!.usage, 'codex').costUsd).toBeCloseTo(expectedCost, 5)
  })

  it.each([1, 2, 3])('waits for implementation after %i continuation records have been written', async (written) => {
    const reader = new CodexTurnUsageReader(session)
    fs.writeFileSync(file, plan.join('\n'))
    expect(reader.read()?.usageId).toBe('codex:plan')
    fs.writeFileSync(file, [...plan, ...implementation.slice(0, written)].join('\n'))
    vi.setSystemTime(now + 2_431_500)
    expect(reader.read()).toMatchObject({ usageId: 'codex:plan', completed: false })
    const pending = reader.finish()
    fs.writeFileSync(file, fullRollout)
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({ completed: true, usage: { inputTokens: 340_583, outputTokens: 39_296 } })
  })

  it('backfills a saved reply and imports history with the same complete usage', () => {
    fs.writeFileSync(file, fullRollout)
    const saved: ResultItem = {
      id: 'result', kind: 'result', cli: 'codex', isError: false,
      createdAt: now + 2_431_500, usageId: 'old-random-id', usageComplete: false,
      model: 'gpt-6-astra[ultra]', durationMs: 2_431_465,
      weeklyQuotaEstimate: { usedPercent: 19 }
    }
    const items: Item[] = [
      { id: 'user', kind: 'user', text: 'Make a plan.', createdAt: now - 300 },
      { id: 'assistant', kind: 'assistant', text: 'Implemented.' }, saved
    ]
    const turns = readCodexUsage(session)!
    expect(repairCodexUsage(items, turns)).toBe(true)
    expect(saved).toMatchObject({
      usageId: 'codex:plan', usageComplete: true, durationMs: 2_431_465,
      weeklyQuotaEstimate: { usedPercent: 19 },
      usage: { inputTokens: 340_583, cacheReadTokens: 11_930_112, outputTokens: 39_296 }
    })
    expect(repairCodexUsage(items, turns)).toBe(false)
    const imported = transcriptItems(fullRollout).filter((item) => item.kind === 'result')
    expect(imported).toHaveLength(1)
    expect(imported[0]).toMatchObject({ usageId: saved.usageId, usage: saved.usage, usageComplete: true })
  })
})
