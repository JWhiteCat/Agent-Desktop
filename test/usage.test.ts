import { describe, expect, it } from 'vitest'
import { quoteModel } from '../src/shared/model-prices'
import { summarizeUsage, type UsageThread } from '../src/shared/usage'
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
  })
})

describe('usage summary', () => {
  const usage = { inputTokens: 1000, outputTokens: 10 }

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
