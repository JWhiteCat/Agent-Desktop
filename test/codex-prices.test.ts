import { describe, expect, it } from 'vitest'
import { quoteModel } from '../src/shared/model-prices'

describe('Codex OpenAI API prices', () => {
  it.each([
    ['gpt-6.1-sol', 0.146],
    ['gpt-6-astra', 0.735],
    ['gpt-6-sol', 0.147],
    ['gpt-6-luna', 0.00735],
    ['gpt-5.6-sol', 0.294],
    ['gpt-5.6-terra', 0.167],
    ['gpt-5.6-luna', 0.0167]
  ])('prices all four token categories for %s', (model, total) => {
    const usage = { inputTokens: 10_000, cacheReadTokens: 10_000, cacheWriteTokens: 10_000, outputTokens: 10_000 }
    expect(quoteModel(`${model}[high]`, usage, 'codex').costUsd).toBeCloseTo(total, 8)
    expect(quoteModel(`${model}[reasoning_effort=high,fast=true]`, usage, 'codex').costUsd).toBeCloseTo(Number(total) * 2, 8)
  })

  it.each([
    { model: 'gpt-6-astra', standard: 0.545, longCost: 1.06502, fastLong: 2.13004 },
    { model: 'gpt-6.1-sol', standard: 0.084, longCost: 0.163004, fastLong: 0.326008 }
  ])('switches $model to long-context rates only above 272k input including cached tokens', ({ model, standard, longCost, fastLong }) => {
    const usage = { inputTokens: 12_000, cacheReadTokens: 250_000, cacheWriteTokens: 10_000, outputTokens: 1_000 }
    expect(quoteModel(`${model}[max]`, usage, 'codex')).toMatchObject({ costUsd: standard, longContext: false })
    const long = { ...usage, inputTokens: 12_001 }
    expect(quoteModel(`${model}[max]`, long, 'codex')).toMatchObject({ costUsd: longCost, longContext: true })
    expect(quoteModel(`${model}[service_tier=priority]`, long, 'codex').costUsd).toBeCloseTo(fastLong, 8)
  })

  it.each(['gpt-6.1-sol', 'gpt-6-1-sol', 'gpt-6.1-sol-2026-09-29', 'gpt-6-1-sol-2026-09-29'])('recognizes the GPT-6.1 Sol alias or snapshot %s', (model) => {
    const usage = { inputTokens: 100_000, cacheReadTokens: 100_000, outputTokens: 10_000 }
    expect(quoteModel(`${model}[high]`, usage, 'codex')).toMatchObject({ label: 'GPT-6.1 Sol', costUsd: 0.31 })
    expect(quoteModel(`${model}-fast`, usage, 'codex')).toMatchObject({ label: 'GPT-6.1 Sol Fast', costUsd: 0.62, fast: true })
  })

  it('uses OpenAI long-context output rates without changing Cursor estimates', () => {
    const usage = { inputTokens: 300_000, outputTokens: 10_000 }
    expect(quoteModel('gpt-5.4', usage, 'codex').costUsd).toBeCloseTo(1.725)
    expect(quoteModel('gpt-5.4', usage, 'cursor').costUsd).toBeCloseTo(1.65)
    expect(quoteModel('gpt-5.4', usage).costUsd).toBeCloseTo(1.65)
  })

  it.each([
    { model: 'gpt-5.4', label: 'GPT-5.4', standard: 0.81, fast: 1.62 },
    { model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', standard: 0.636, fast: 1.272 }
  ])('prices each $model request before adding a turn that exceeds the context threshold in total', ({ model, label, standard, fast }) => {
    const request = { inputTokens: 100_000, cacheReadTokens: 20_000, outputTokens: 1_000 }
    const usage = {
      inputTokens: 300_000,
      cacheReadTokens: 60_000,
      outputTokens: 3_000,
      requests: [request, request, request]
    }
    expect(quoteModel(model, usage, 'codex')).toMatchObject({
      costUsd: standard,
      longContext: false,
      label
    })
    expect(quoteModel(`${model}-fast`, usage, 'codex')).toMatchObject({ costUsd: fast, longContext: false })
  })

  it('applies long-context pricing only to requests that cross the threshold', () => {
    const usage = {
      inputTokens: 400_000,
      outputTokens: 2_000,
      requests: [
        { inputTokens: 100_000, outputTokens: 1_000 },
        { inputTokens: 300_000, outputTokens: 1_000 }
      ]
    }
    expect(quoteModel('gpt-5.4', usage, 'codex')).toMatchObject({ costUsd: 1.7875, longContext: true })
    expect(quoteModel('gpt-5.4-fast', usage, 'codex').costUsd).toBeNull()
  })

  it('uses legacy totals when request details are absent or empty', () => {
    const usage = { inputTokens: 300_000, outputTokens: 1_000 }
    expect(quoteModel('gpt-5.4', { ...usage, requests: [] }, 'codex')).toEqual(quoteModel('gpt-5.4', usage, 'codex'))
  })

  it('uses the published GPT-5.5 Fast multiplier and leaves unlisted Fast tiers unpriced', () => {
    expect(quoteModel('gpt-5.5-fast', { inputTokens: 100_000, outputTokens: 10_000 }, 'codex').costUsd).toBe(2)
    expect(quoteModel('gpt-5.4-nano-fast', { inputTokens: 100 }, 'codex').costUsd).toBeNull()
    expect(quoteModel('gpt-5.5-fast', { inputTokens: 300_000 }, 'codex').costUsd).toBeNull()
  })

  it('prices older Codex models and dated snapshots using their own cache discount', () => {
    const usage = { inputTokens: 100_000, cacheReadTokens: 100_000, outputTokens: 10_000 }
    expect(quoteModel('gpt-5.3-codex[high]', usage, 'codex')).toMatchObject({ label: 'GPT-5.3 Codex', costUsd: 0.3325 })
    expect(quoteModel('gpt-5.3-codex[fast=true]', usage, 'codex').costUsd).toBe(0.665)
    expect(quoteModel('gpt-5.1-codex-max', usage, 'codex').costUsd).toBe(0.2375)
    expect(quoteModel('gpt-5.1-codex-mini', usage, 'codex').costUsd).toBe(0.0475)
    expect(quoteModel('codex-mini-latest', usage, 'codex').costUsd).toBe(0.2475)
    expect(quoteModel('gpt-5-2025-08-07[high]', usage, 'codex').costUsd).toBe(0.2375)
  })

  it.each(['auto', 'grok-4.7', 'gpt-6-astra-custom', 'gpt-6.1-sol-custom', 'gpt-6.1-pro', 'gpt-5.3-codex-spark', 'gpt-5.4-codex', 'gpt-5-pro'])('does not invent a Codex price for %s', (model) => {
    expect(quoteModel(model, { inputTokens: 1_000 }, 'codex').costUsd).toBeNull()
  })
})
