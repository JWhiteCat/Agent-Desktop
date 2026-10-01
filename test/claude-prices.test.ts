import { describe, expect, it } from 'vitest'
import { quoteModel } from '../src/shared/model-prices'
import { StreamReducer } from '../src/main/reducer'
import { summarizeUsage } from '../src/shared/usage'

const usage = { inputTokens: 10_000, cacheReadTokens: 10_000, cacheWriteTokens: 10_000, outputTokens: 10_000 }

describe('Claude Code Anthropic API prices', () => {
  it.each([
    ['claude-fable-5-1', 'Claude Fable 5.1', 0.7275],
    ['claude-fable-5', 'Claude Fable 5', 0.735],
    ['claude-opus-5-5', 'Claude Opus 5.5', 0.292],
    ['claude-opus-5', 'Claude Opus 5', 0.3675],
    ['claude-opus-4-8', 'Claude Opus 4.8', 0.3675],
    ['claude-opus-4-1', 'Claude Opus 4.1', 1.1025],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 0.147],
    ['claude-sonnet-5', 'Claude Sonnet 5', 0.147],
    ['claude-sonnet-4-6', 'Claude Sonnet 4.6', 0.2205],
    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 0.0735],
    ['claude-3-5-haiku-20241022', 'Claude Haiku 3.5', 0.0588]
  ])('prices all four token categories for %s', (model, label, total) => {
    expect(quoteModel(model, usage, 'claude')).toMatchObject({ label, longContext: false })
    expect(quoteModel(model, usage, 'claude').costUsd).toBeCloseTo(total, 8)
  })

  it('bills the 1M context at standard rates and ignores the context hint', () => {
    const long = { inputTokens: 900_000, outputTokens: 1_000 }
    expect(quoteModel('claude-opus-5-5[1m]', long, 'claude')).toMatchObject({ costUsd: 3.62, longContext: false, label: 'Claude Opus 5.5' })
  })

  it('leaves aliases, unknown snapshots and unlisted Fast pricing unpriced', () => {
    expect(quoteModel('opus[context=1m,effort=high]', usage, 'claude').costUsd).toBeNull()
    expect(quoteModel('haiku', usage, 'claude').costUsd).toBeNull()
    expect(quoteModel('claude-opus-5-5-preview', usage, 'claude').costUsd).toBeNull()
    expect(quoteModel('claude-opus-5-5-fast', usage, 'claude').costUsd).toBeNull()
  })

  it('does not change Cursor estimates for the same model name', () => {
    expect(quoteModel('claude-opus-4-7', usage, 'cursor').costUsd).toBeCloseTo(0.3675, 8)
    expect(quoteModel('claude-opus-4.7-fast', usage, 'cursor').costUsd).toBeCloseTo(2.205, 8)
  })

  it('keeps the API model Claude attaches to usage updates', () => {
    const reducer = new StreamReducer([])
    reducer.handleAcp({ sessionUpdate: 'usage_update', used: 1, _meta: { '_claude/model': 'claude-opus-5-5' } })
    reducer.handleAcp({ sessionUpdate: 'usage_update', used: 2 })
    expect(reducer.lastModel).toBe('claude-opus-5-5')
  })

  it('prices summaries from the recorded API model while keeping the chosen alias', () => {
    const now = 1_700_000_000_000
    const summary = summarizeUsage([{
      cli: 'claude',
      items: [
        { id: 'r1', kind: 'result', isError: false, createdAt: now - 1, model: 'opus[effort=high]', apiModel: 'claude-opus-5-5', usage },
        { id: 'r2', kind: 'result', isError: false, createdAt: now - 1, model: 'opus[effort=low]', usage }
      ]
    }], '1d', now)
    expect(summary.models.find((row) => row.model === 'opus[effort=high]')).toMatchObject({ label: 'Claude Opus 5.5' })
    expect(summary.costUsd).toBeCloseTo(0.292, 8)
    expect(summary.unpricedTurns).toBe(1)
  })
})
