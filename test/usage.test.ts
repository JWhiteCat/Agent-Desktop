import { describe, expect, it } from 'vitest'
import { quoteModel } from '../src/shared/model-prices'
import { listSessionUsage, summarizeUsage, type UsageThread } from '../src/shared/usage'
import type { Item } from '../src/shared/types'

const GROK = 'grok-4.7[context=256k,reasoning_effort=high,fast=false]'
const GROK_FAST = 'grok-4.7[context=256k,reasoning_effort=high,fast=true]'
const GROK_500 = 'grok-4.7[context=500k,reasoning_effort=high,fast=false]'
const GROK_500_FAST = 'grok-4.7[context=500k,reasoning_effort=high,fast=true]'

const now = 1_700_000_000_000
const hour = 60 * 60 * 1000
const day = 24 * hour

function user(createdAt: number, id = 'u'): Item {
  return { id, kind: 'user', text: 'hi', createdAt }
}

function result(patch: Partial<Extract<Item, { kind: 'result' }>> & { id: string }): Item {
  return { kind: 'result', isError: false, ...patch }
}

describe('model prices', () => {
  it('prices Grok 4.7 standard, Fast, long context, and Fast long context', () => {
    expect(quoteModel(GROK, { inputTokens: 100_000 }).costUsd).toBeCloseTo(0.2)
    expect(quoteModel(GROK_FAST, { inputTokens: 100_000 }).costUsd).toBeCloseTo(0.4)
    expect(quoteModel(GROK, { inputTokens: 256_000 }).costUsd).toBeCloseTo(0.512)
    expect(quoteModel(GROK, { inputTokens: 256_001 }).costUsd).toBeCloseTo(1.024004)
    expect(quoteModel(GROK, { inputTokens: 300_000 }).costUsd).toBeCloseTo(1.2)
    expect(quoteModel(GROK_FAST, { inputTokens: 300_000 }).costUsd).toBeCloseTo(1.8)
    expect(quoteModel(GROK_500, { inputTokens: 100_000 }).costUsd).toBeCloseTo(0.2)
    expect(quoteModel(GROK_500_FAST, { inputTokens: 300_000 }).costUsd).toBeCloseTo(1.8)
    expect(quoteModel(GROK_500_FAST, { inputTokens: 300_000 }).label).toBe('Grok 4.7 Fast 长上下文')
  })

  it('does not bill Grok cache writes, and prices Grok 4.5 Fast output from the table', () => {
    const base = quoteModel(GROK, { inputTokens: 100_000 })
    const withWrite = quoteModel(GROK, { inputTokens: 100_000, cacheWriteTokens: 50_000 })
    expect(withWrite.costUsd).toBe(base.costUsd)
    expect(quoteModel(GROK, { cacheReadTokens: 100_000 }).costUsd).toBeCloseTo(0.05)
    expect(quoteModel('grok-4.5-fast', { outputTokens: 1_000_000 }).costUsd).toBe(18)
    expect(quoteModel('grok-4.6-fast', { outputTokens: 1_000_000 }).costUsd).toBe(12)
  })

  it('leaves auto and unknown models unpriced', () => {
    expect(quoteModel('auto', { inputTokens: 1_000 }).costUsd).toBeNull()
    expect(quoteModel('some-new-model', { inputTokens: 1_000 }).costUsd).toBeNull()
    expect(quoteModel('gpt-5.4-mini', { inputTokens: 1_000_000 }).costUsd).toBeCloseTo(0.75)
    expect(quoteModel('gpt-5.4', { inputTokens: 1_000_000 }).costUsd).toBeCloseTo(5)
    const codex = quoteModel('gpt-5.4-codex', { inputTokens: 1_000_000 })
    expect(codex.label).toBe('GPT-5.4 Codex 长上下文')
    expect(codex.costUsd).toBeCloseTo(5)
    expect(quoteModel('gpt-5.3-codex', { inputTokens: 1_000_000 }).label).toBe('GPT-5.3 Codex')
  })
})

describe('usage summary', () => {
  const usage = { inputTokens: 1000, outputTokens: 10 }

  it('prices the same model separately for Cursor and Codex without merging their turns', () => {
    const at = now - hour
    const sharedUsage = { inputTokens: 300_000, outputTokens: 1000 }
    const items = [user(at), result({ id: 'r', model: 'gpt-5.4[high]', createdAt: at, usage: sharedUsage })]
    const summary = summarizeUsage([
      { cli: 'cursor', items },
      { cli: 'codex', items }
    ], '1d', now)

    expect(summary.turns).toBe(2)
    expect(summary.models).toHaveLength(2)
    expect(summary.models.find((row) => row.cli === 'cursor')?.costUsd).toBeCloseTo(1.515)
    expect(summary.models.find((row) => row.cli === 'codex')?.costUsd).toBeCloseTo(1.5225)
    expect(summary.costUsd).toBeCloseTo(3.0375)
  })

  it('counts a stable usage id once even when a copied thread switches CLI', () => {
    const at = now - hour
    const items = [user(at), result({ id: 'r', usageId: 'same', model: 'gpt-5.4', createdAt: at, usage })]
    const summary = summarizeUsage([
      { items },
      { cli: 'cursor', items },
      { cli: 'codex', items },
      { cli: 'codex', items }
    ], '1d', now)

    expect(summary.turns).toBe(1)
    expect(summary.models.map((row) => row.cli)).toEqual(['cursor'])
    expect(summary.models.every((row) => row.turns === 1)).toBe(true)
  })

  it('keeps each recorded turn on its original CLI after the conversation switches CLI', () => {
    const at = now - hour
    const sharedUsage = { inputTokens: 300_000, outputTokens: 1_000 }
    const thread: UsageThread = {
      id: 'switched',
      cli: 'claude',
      items: [
        result({ id: 'cursor', usageId: 'cursor-turn', cli: 'cursor', model: 'gpt-5.4', createdAt: at, usage: sharedUsage }),
        result({ id: 'codex', usageId: 'codex-turn', cli: 'codex', model: 'gpt-5.4', createdAt: at, usage: sharedUsage })
      ]
    }
    const summary = summarizeUsage([thread, { ...thread, id: 'fork', cli: 'cursor' }], '1d', now)
    expect(summary.turns).toBe(2)
    expect(summary.models.find((row) => row.cli === 'cursor')?.costUsd).toBeCloseTo(1.515)
    expect(summary.models.find((row) => row.cli === 'codex')?.costUsd).toBeCloseTo(1.5225)
    expect(summary.models.some((row) => row.cli === 'claude')).toBe(false)
    expect(listSessionUsage([thread])[0].costUsd).toBeCloseTo(3.0375)
  })

  it('counts request details only in the price, without adding their tokens again', () => {
    const request = { inputTokens: 100_000, cacheReadTokens: 20_000, outputTokens: 1_000 }
    const thread: UsageThread = {
      id: 'requests',
      cli: 'codex',
      items: [result({
        id: 'r',
        model: 'gpt-5.4',
        createdAt: now - hour,
        usage: { inputTokens: 300_000, cacheReadTokens: 60_000, outputTokens: 3_000, requests: [request, request, request] }
      })]
    }
    const expected = { turns: 1, inputTokens: 300_000, cacheReadTokens: 60_000, outputTokens: 3_000, costUsd: 0.81 }
    expect(summarizeUsage([thread], '1d', now)).toMatchObject(expected)
    expect(listSessionUsage([thread])[0]).toMatchObject(expected)
  })

  it('keeps turns inside 1, 7, and 30 day windows', () => {
    const thread: UsageThread = {
      model: 'grok-4.7',
      items: [
        user(now - 2 * hour, 'u1'),
        result({ id: 'a', usageId: 'a', usage }),
        user(now - 3 * day, 'u2'),
        result({ id: 'b', usageId: 'b', usage }),
        user(now - 10 * day, 'u3'),
        result({ id: 'c', usageId: 'c', usage }),
        user(now - 40 * day, 'u4'),
        result({ id: 'd', usageId: 'd', usage })
      ]
    }
    expect(summarizeUsage([thread], '1d', now).turns).toBe(1)
    expect(summarizeUsage([thread], '7d', now).turns).toBe(2)
    expect(summarizeUsage([thread], '30d', now).turns).toBe(3)
  })

  it('counts a forked turn once', () => {
    const at = now - hour
    const stamped: UsageThread[] = [
      { model: 'grok-4.7', items: [user(at, 'u1'), result({ id: 'r1', usageId: 'same', model: 'grok-4.7', createdAt: at, usage })] },
      { model: 'grok-4.7', items: [user(at, 'u2'), result({ id: 'r2', usageId: 'same', model: 'grok-4.7', createdAt: at, usage })] }
    ]
    expect(summarizeUsage(stamped, '1d', now).turns).toBe(1)

    const legacy: UsageThread[] = [
      { model: 'grok-4.7', items: [user(at, 'u3'), result({ id: 'r3', usage })] },
      { model: 'grok-4.7', items: [user(at, 'u4'), result({ id: 'r4', usage })] }
    ]
    expect(summarizeUsage(legacy, '1d', now).turns).toBe(1)
  })

  it('sums priced models and keeps unpriced turns out of the total', () => {
    const at = now - hour
    const thread: UsageThread = {
      items: [
        result({ id: 'r3', usage: { inputTokens: 1 } }),
        user(at, 'u1'),
        result({ id: 'r1', usageId: '1', model: 'grok-4.7', createdAt: at, usage: { inputTokens: 1_000_000 } }),
        user(at, 'u2'),
        result({ id: 'r2', usageId: '2', model: 'mystery', createdAt: at, usage: { inputTokens: 500 } })
      ]
    }
    const summary = summarizeUsage([thread], '7d', now)
    expect(summary.turns).toBe(2)
    expect(summary.unpricedTurns).toBe(1)
    expect(summary.costUsd).toBeCloseTo(4)
    expect(summary.inputTokens).toBe(1_000_500)
    expect(summary.models[0].label).toBe('Grok 4.7 长上下文')
    expect(summary.models[1].costUsd).toBeNull()
    expect(summarizeUsage([{ items: [user(at), result({ id: 'only', model: 'auto', createdAt: at, usage })] }], '1d', now).costUsd).toBeNull()
  })
})

describe('session usage', () => {
  const usage = { inputTokens: 1000, outputTokens: 10 }

  it('uses the session CLI for costs and model labels, including sessions with no usage', () => {
    const at = now - hour
    const rows = listSessionUsage([
      { id: 'empty', cli: 'codex', model: 'gpt-6-sol[high]', items: [] },
      {
        id: 'codex',
        cli: 'codex',
        items: [result({ id: 'r', model: 'gpt-5.4', createdAt: at, usage: { inputTokens: 300_000, outputTokens: 1000 } })]
      },
      { id: 'legacy', model: 'gpt-5.4', items: [] }
    ])

    expect(rows.find((row) => row.threadId === 'codex')).toMatchObject({ cli: 'codex', costUsd: 1.5225 })
    expect(rows.find((row) => row.threadId === 'empty')).toMatchObject({
      cli: 'codex',
      models: [{ id: 'gpt-6-sol[high]', label: 'GPT-6 Sol' }],
      costUsd: null
    })
    expect(rows.find((row) => row.threadId === 'legacy')?.cli).toBe('cursor')
  })

  it('counts every turn on a session, including ones outside the summary window', () => {
    const thread: UsageThread = {
      id: 't1',
      title: '长对话',
      project: 'AgentDesktop',
      model: 'grok-4.7',
      items: [
        user(now - 2 * hour, 'u1'),
        result({ id: 'a', usageId: 'a', usage }),
        user(now - 40 * day, 'u4'),
        result({ id: 'd', usageId: 'd', usage })
      ]
    }
    expect(summarizeUsage([thread], '30d', now).turns).toBe(1)
    const [row] = listSessionUsage([thread])
    expect(row).toMatchObject({
      threadId: 't1',
      title: '长对话',
      project: 'AgentDesktop',
      models: [{ id: 'grok-4.7', label: 'Grok 4.7' }],
      at: now - 2 * hour,
      turns: 2,
      inputTokens: 2000,
      outputTokens: 20
    })
    expect(row.costUsd).toBeGreaterThan(0)
  })

  it('lists a forked turn on each session while the summary counts it once', () => {
    const at = now - hour
    const threads: UsageThread[] = [
      {
        id: 'a',
        title: '原会话',
        items: [user(at, 'u1'), result({ id: 'r1', usageId: 'same', model: 'grok-4.7', createdAt: at, usage })]
      },
      {
        id: 'b',
        title: '分叉',
        items: [user(at, 'u2'), result({ id: 'r2', usageId: 'same', model: 'grok-4.7', createdAt: at, usage })]
      }
    ]
    expect(summarizeUsage(threads, '1d', now).turns).toBe(1)
    const rows = listSessionUsage(threads)
    expect(rows.map((row) => row.threadId).sort()).toEqual(['a', 'b'])
    expect(rows.every((row) => row.turns === 1 && row.inputTokens === 1000)).toBe(true)
  })

  it('keeps every session, including ones with no usage, and lists each model used', () => {
    const at = now - hour
    const rows = listSessionUsage([
      { id: 'empty', title: '空', model: 'gpt-5.4', updatedAt: at - hour, items: [user(at)] },
      {
        id: 'mixed',
        title: '  ',
        items: [
          user(at, 'u1'),
          result({ id: 'priced', usageId: '1', model: 'grok-4.7', createdAt: at, usage }),
          user(at, 'u2'),
          result({ id: 'auto', usageId: '2', model: 'auto', createdAt: at, usage })
        ]
      }
    ])
    expect(rows.map((row) => row.threadId)).toEqual(['mixed', 'empty'])
    expect(rows[0]).toMatchObject({
      title: '未命名',
      turns: 2,
      models: [
        { id: 'grok-4.7', label: 'Grok 4.7' },
        { id: 'auto', label: 'Auto' }
      ]
    })
    expect(rows[0].costUsd).toBeGreaterThan(0)
    expect(rows[1]).toMatchObject({
      title: '空',
      turns: 0,
      inputTokens: 0,
      costUsd: null,
      at: at - hour,
      models: [{ id: 'gpt-5.4', label: 'GPT-5.4' }]
    })
  })

  it('sorts sessions by the latest usage time', () => {
    const rows = listSessionUsage([
      { id: 'old', title: '旧', items: [result({ id: 'r1', usageId: '1', model: 'grok-4.7', createdAt: now - 2 * day, usage })] },
      { id: 'new', title: '新', items: [result({ id: 'r2', usageId: '2', model: 'grok-4.7', createdAt: now - hour, usage })] }
    ])
    expect(rows.map((row) => row.threadId)).toEqual(['new', 'old'])
  })
})
