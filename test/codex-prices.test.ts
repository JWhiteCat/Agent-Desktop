import { describe, expect, it } from 'vitest'
import { quoteModel } from '../src/shared/model-prices'

describe('Codex OpenAI API prices', () => {
  it.each([
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

  it('switches to long-context rates only above 272k input including cached tokens', () => {
    const usage = { inputTokens: 12_000, cacheReadTokens: 250_000, cacheWriteTokens: 10_000, outputTokens: 1_000 }
    expect(quoteModel('gpt-6-astra[ultra]', usage, 'codex')).toMatchObject({ costUsd: 0.545, longContext: false })
    const long = { ...usage, inputTokens: 12_001 }
    expect(quoteModel('gpt-6-astra[ultra]', long, 'codex')).toMatchObject({ costUsd: 1.06502, longContext: true })
    expect(quoteModel('gpt-6-astra[service_tier=priority]', long, 'codex').costUsd).toBeCloseTo(2.13004, 8)
  })

  it('uses OpenAI long-context output rates without changing Cursor estimates', () => {
    const usage = { inputTokens: 300_000, outputTokens: 10_000 }
    expect(quoteModel('gpt-5.4', usage, 'codex').costUsd).toBeCloseTo(1.725)
    expect(quoteModel('gpt-5.4', usage, 'cursor').costUsd).toBeCloseTo(1.65)
    expect(quoteModel('gpt-5.4', usage).costUsd).toBeCloseTo(1.65)
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

  it.each(['auto', 'grok-4.7', 'gpt-6-astra-custom', 'gpt-5.3-codex-spark', 'gpt-5.4-codex', 'gpt-5-pro'])('does not invent a Codex price for %s', (model) => {
    expect(quoteModel(model, { inputTokens: 1_000 }, 'codex').costUsd).toBeNull()
  })
})
