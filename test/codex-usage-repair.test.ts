import { describe, expect, it } from 'vitest'
import type { Item, ResultItem } from '../src/shared/types'
import type { CodexUsageTurn } from '../src/main/codex-usage'
import { repairCodexUsage } from '../src/main/codex-usage-repair'

const now = 1_700_000_000_000

function user(at: number, id = 'user'): Item {
  return { id, kind: 'user', text: 'Keep this message.', createdAt: now + at }
}

function result(at: number | undefined, patch: Partial<ResultItem> = {}): ResultItem {
  return { id: 'result', kind: 'result', isError: false, ...(at === undefined ? {} : { createdAt: now + at }), ...patch }
}

function turn(id: string, start: number, end: number, patch: Partial<CodexUsageTurn> = {}): CodexUsageTurn {
  return {
    usageId: `codex:chat:${id}`,
    turnId: id,
    startedAt: now + start,
    createdAt: now + end,
    model: 'gpt-5.4',
    usage: {
      inputTokens: 1_000,
      cacheReadTokens: 9_000,
      outputTokens: 100,
      requests: [
        { inputTokens: 500, cacheReadTokens: 4_000, outputTokens: 40 },
        { inputTokens: 500, cacheReadTokens: 5_000, outputTokens: 60 }
      ]
    },
    isError: false,
    completed: true,
    endLine: 10,
    ...patch
  }
}

describe('repairCodexUsage', () => {
  it('restores a missing quota snapshot without replacing a newer saved reading', () => {
    const quotaSnapshot = { sampledAt: now + 29_000, weekly: { usedPercent: 37 } }
    const parsed = turn('one', 1_000, 30_000, { quotaSnapshot })
    const saved = result(31_000, { usageId: parsed.usageId })
    expect(repairCodexUsage([saved], [parsed])).toBe(true)
    expect(saved.quotaSnapshot).toEqual(quotaSnapshot)
    const newer = { sampledAt: now + 32_000, weekly: { usedPercent: 38 } }
    saved.quotaSnapshot = newer
    expect(repairCodexUsage([saved], [parsed])).toBe(false)
    expect(saved.quotaSnapshot).toBe(newer)
  })

  it('repairs old and missing usage across multiple turns without replacing messages', () => {
    const first = result(32_000, { usageId: 'old-random-id', usage: { inputTokens: 500 } })
    const second = result(122_000, { id: 'result-2' })
    const assistant: Item = { id: 'answer', kind: 'assistant', text: 'Keep this answer.' }
    const items = [user(0), assistant, first, user(60_000, 'user-2'), second]
    const turns = [turn('one', 1_000, 30_000), turn('two', 100_000, 120_000)]

    expect(repairCodexUsage(items, turns)).toBe(true)
    expect(first.usage).toEqual(turns[0].usage)
    expect(second.usage).toEqual(turns[1].usage)
    expect(first.usageId).toBe(turns[0].usageId)
    expect(second.usageId).toBe(turns[1].usageId)
    expect(first.cli).toBe('codex')
    expect(second.cli).toBe('codex')
    expect(items).toHaveLength(5)
    expect(items[1]).toBe(assistant)
    expect(items[2]).toBe(first)
    expect(items[4]).toBe(second)
  })

  it('matches stable usage IDs before timestamps and preserves result metadata', () => {
    const parsed = turn('one', 1_000, 30_000)
    const quotaUsage = { weekly: 0.5, fiveHour: 2 }
    const saved = result(undefined, {
      usageId: parsed.usageId,
      model: 'gpt-5.4[reasoning_effort=high]',
      durationMs: 31_234,
      quotaUsage,
      isError: true,
      usage: { inputTokens: 5 }
    })
    const original = { ...saved }

    expect(repairCodexUsage([saved], [parsed])).toBe(true)
    expect(saved).toEqual({ ...original, usage: parsed.usage, cli: 'codex', usageComplete: true })
    expect(saved.quotaUsage).toBe(quotaUsage)
  })

  it('fills a missing model and is idempotent once repaired', () => {
    const saved = result(31_000)
    const parsed = turn('one', 1_000, 30_000)
    const items = [user(0), saved]
    expect(repairCodexUsage(items, [parsed])).toBe(true)
    expect(saved.model).toBe(parsed.model)
    const snapshot = structuredClone(items)
    const usage = saved.usage

    expect(repairCodexUsage(items, [parsed])).toBe(false)
    expect(items).toEqual(snapshot)
    expect(saved.usage).toBe(usage)
  })

  it('replaces incomplete per-request usage once the complete turn is available', () => {
    const parsed = turn('one', 1_000, 30_000)
    const saved = result(31_000, {
      cli: 'codex',
      usageId: parsed.usageId,
      usageComplete: false,
      usage: { inputTokens: 500, requests: [{ inputTokens: 500 }] }
    })

    expect(repairCodexUsage([user(0), saved], [parsed])).toBe(true)
    expect(saved.usage).toEqual(parsed.usage)
    expect(saved.usageComplete).toBe(true)
    expect(repairCodexUsage([user(0), saved], [parsed])).toBe(false)
  })

  it('does not guess from order, absent timestamps, or a nearby result alone', () => {
    const cases = [
      [user(0), result(undefined)],
      [result(31_000)],
      [user(2_000), result(31_000)],
      [user(0), result(60_000)],
      [user(40_000), result(31_000)],
      [{ ...user(0), createdAt: 0 }, result(31_000)]
    ]
    for (const items of cases) {
      const original = structuredClone(items)
      expect(repairCodexUsage(items, [turn('one', 1_000, 30_000)])).toBe(false)
      expect(items).toEqual(original)
    }
  })

  it('requires a unique time match in both directions', () => {
    const saved = result(31_000)
    expect(repairCodexUsage([user(0), saved], [turn('one', 1_000, 30_000), turn('two', 2_000, 32_000)])).toBe(false)
    const duplicate = result(31_000, { id: 'second-result' })
    expect(repairCodexUsage([user(0), saved, duplicate], [turn('one', 1_000, 30_000)])).toBe(false)
    expect(saved.usage).toBeUndefined()
    expect(duplicate.usage).toBeUndefined()
  })

  it('does not reuse a turn already identified by its usage ID', () => {
    const parsed = turn('one', 1_000, 30_000)
    const exact = result(31_000, { usageId: parsed.usageId })
    const unrelated = result(31_000, { id: 'unrelated' })
    expect(repairCodexUsage([user(0), unrelated, exact], [parsed])).toBe(true)
    expect(exact.usage).toEqual(parsed.usage)
    expect(unrelated.usage).toBeUndefined()
  })

  it('never changes results explicitly owned by another CLI', () => {
    const parsed = turn('one', 1_000, 30_000)
    for (const cli of ['cursor', 'claude'] as const) {
      const saved = result(31_000, { cli, usageId: parsed.usageId, usage: { outputTokens: 7 } })
      const original = structuredClone(saved)
      expect(repairCodexUsage([user(0), saved], [parsed])).toBe(false)
      expect(saved).toEqual(original)
    }
  })

  it('rejects incomplete turns, duplicate stable IDs, and a turn crossing the next user', () => {
    const parsed = turn('one', 1_000, 30_000)
    const incomplete = { ...parsed, completed: false }
    const saved = result(31_000, { usageId: parsed.usageId })
    expect(repairCodexUsage([saved], [incomplete])).toBe(false)
    expect(repairCodexUsage([saved], [parsed, { ...parsed }])).toBe(false)
    const crossing = result(31_000)
    expect(repairCodexUsage([user(0), crossing, user(20_000, 'next')], [parsed])).toBe(false)
  })

  it('does not add a result to a transcript without one', () => {
    const items: Item[] = [user(0), { id: 'answer', kind: 'assistant', text: 'Done.' }]
    const original = structuredClone(items)
    expect(repairCodexUsage(items, [turn('one', 1_000, 30_000)])).toBe(false)
    expect(items).toEqual(original)
  })
})
