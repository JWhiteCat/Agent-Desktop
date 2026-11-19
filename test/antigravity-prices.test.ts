import { describe, expect, it } from 'vitest'
import { modelPriceTip, quoteModel } from '../src/shared/model-prices'
import { listSessionUsage, summarizeUsage } from '../src/shared/usage'

const usage = { inputTokens: 10_000, cacheReadTokens: 10_000, cacheWriteTokens: 10_000, outputTokens: 10_000 }

describe('Antigravity Gemini API and Google Cloud prices', () => {
  it.each([
    ['gemini-4-carbon', 'Gemini 4 Carbon', 0.121],
    ['gemini-4-argon', 'Gemini 4 Argon', 0.121],
    ['gemini-4-hydrogen', 'Gemini 4 Hydrogen', 0.09075],
    ['gemini-4-neon', 'Gemini 4 Neon', 0.1815],
    ['gemini-3.8-flash', 'Gemini 3.8 Flash', 0.04575],
    ['gemini-3.7-flash', 'Gemini 3.7 Flash', 0.04575],
    ['gemini-3.6-flash', 'Gemini 3.6 Flash', 0.04575],
    ['gemini-3.5-flash', 'Gemini 3.5 Flash', 0.1065],
    ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 0.0283],
    ['gemini-3.1-pro', 'Gemini 3.1 Pro', 0.142],
    ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro', 0.142],
    ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 0.01775],
    ['gemini-3-flash-preview', 'Gemini 3 Flash', 0.0355],
    ['gemini-2.5-pro', 'Gemini 2.5 Pro', 0.11375],
    ['gemini-2.5-flash', 'Gemini 2.5 Flash', 0.0283],
    ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 0.0051],
    ['claude-opus-5-5', 'Claude Opus 5.5', 0.292],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 0.146],
    ['claude-opus-4-6', 'Claude Opus 4.6', 0.3675],
    ['claude-sonnet-4-6', 'Claude Sonnet 4.6', 0.2205],
    ['gpt-oss-120b', 'GPT-OSS 120B', 0.0045],
    ['gpt-oss-20b', 'GPT-OSS 20B', 0.00327]
  ])('prices all four token categories for %s', (model, label, total) => {
    expect(quoteModel(model, usage, 'antigravity')).toMatchObject({ label, longContext: false })
    expect(quoteModel(model, usage, 'antigravity').costUsd).toBeCloseTo(total, 8)
  })

  it.each([
    ['gemini-4-carbon[effort=high]', 'Gemini 4 Carbon', 0.121],
    ['gemini-4-hydrogen[effort=xhigh]', 'Gemini 4 Hydrogen', 0.09075],
    ['gemini-4-carbon-medium', 'Gemini 4 Carbon', 0.121],
    ['gemini-4-hydrogen-xhigh', 'Gemini 4 Hydrogen', 0.09075],
    ['agy/gemini-4-carbon-high', 'Gemini 4 Carbon', 0.121],
    ['gemini-4-neon[effort=high]', 'Gemini 4 Neon', 0.1815],
    ['agy/gemini-4-neon-medium', 'Gemini 4 Neon', 0.1815],
    ['models/agy/gemini-4-neon-high', 'Gemini 4 Neon', 0.1815],
    ['models/agy/gemini-4-carbon-high', 'Gemini 4 Carbon', 0.121],
    ['claude-opus-5-5-max', 'Claude Opus 5.5', 0.292],
    ['claude-sonnet-5-5[effort=low]', 'Claude Sonnet 5.5', 0.146],
    ['claude-opus-4-6@default', 'Claude Opus 4.6', 0.3675],
    ['openai/gpt-oss-120b-maas', 'GPT-OSS 120B', 0.0045]
  ])('normalizes Antigravity variant or gateway id %s', (model, label, total) => {
    expect(quoteModel(model, usage, 'antigravity')).toMatchObject({ label, costUsd: total })
  })

  it('applies >200k long-context pricing to Gemini 3.1 Pro and Gemini 2.5 Pro', () => {
    const atThreshold = { inputTokens: 150_000, cacheReadTokens: 50_000, outputTokens: 10_000 }
    expect(quoteModel('gemini-3.1-pro[effort=high]', atThreshold, 'antigravity')).toMatchObject({
      label: 'Gemini 3.1 Pro',
      costUsd: 0.43,
      longContext: false
    })
    const overThreshold = { ...atThreshold, inputTokens: 150_001 }
    expect(quoteModel('gemini-3.1-pro[effort=high]', overThreshold, 'antigravity')).toMatchObject({
      label: 'Gemini 3.1 Pro 长上下文',
      costUsd: 0.800004,
      longContext: true
    })
    expect(quoteModel('gemini-2.5-pro', overThreshold, 'antigravity')).toMatchObject({
      label: 'Gemini 2.5 Pro 长上下文',
      costUsd: 0.5375025,
      longContext: true
    })
  })

  it('prices Gemini 3.6 Flash differently in Antigravity and Cursor without cross-contaminating CLIs', () => {
    const sample = { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(quoteModel('gemini-3.6-flash[effort=medium]', sample, 'antigravity').costUsd).toBeCloseTo(4.575, 8)
    expect(quoteModel('gemini-3.6-flash', sample, 'cursor').costUsd).toBeCloseTo(9.15, 8)
  })

  it.each([
    'auto',
    'Orchestrator (Carbon)',
    'Orchestrator (Argon)',
    'gemini-pro-orchestrator',
    'gemini-pro-orchestrator-argon',
    'gemini-4-carbon-fast',
    'gemini-4-carbon-custom',
    'grok-4.7'
  ])('leaves Orchestrator, unlisted Fast, and non-Antigravity model %s unpriced', (model) => {
    expect(quoteModel(model, usage, 'antigravity').costUsd).toBeNull()
  })

  it('formats hover price tooltips with Gemini API / Google Cloud attribution', () => {
    expect(modelPriceTip('gemini-4-carbon[effort=high]', 'antigravity', 'Gemini 4 Carbon · High')).toBe([
      'Gemini 4 Carbon · High',
      '输入 $2 · 输出 $10 · 缓存读 $0.1 / 百万 token',
      'Gemini API / Google Cloud 公开标价'
    ].join('\n'))
    expect(modelPriceTip('gemini-3.1-pro', 'antigravity')).toContain('长上下文（输入 > 200k）：输入 $4 · 输出 $18 · 缓存读 $0.4')
    expect(modelPriceTip('Orchestrator (Carbon)', 'antigravity')).toBe('未定价')
  })

  it('rolls up priced Antigravity turns and excludes Orchestrator turns from cost totals', () => {
    const now = 1_700_000_000_000
    const threads = [{
      id: 'agy-chat',
      cli: 'antigravity' as const,
      items: [
        {
          id: 'r1',
          kind: 'result' as const,
          isError: false,
          cli: 'antigravity' as const,
          createdAt: now - 1_000,
          model: 'gemini-4-carbon[effort=high]',
          usage: { inputTokens: 8_780, outputTokens: 69, cacheReadTokens: 0, cacheWriteTokens: 0 }
        },
        {
          id: 'r2',
          kind: 'result' as const,
          isError: false,
          cli: 'antigravity' as const,
          createdAt: now - 500,
          model: 'Orchestrator (Carbon)',
          usage: { inputTokens: 5_000, outputTokens: 500 }
        }
      ]
    }]
    const summary = summarizeUsage(threads, '1d', now)
    expect(summary.turns).toBe(2)
    expect(summary.unpricedTurns).toBe(1)
    expect(summary.costUsd).toBeCloseTo(0.01825, 8)
    expect(listSessionUsage(threads)[0]).toMatchObject({
      cli: 'antigravity',
      turns: 2,
      costUsd: 0.01825,
      models: [
        { id: 'gemini-4-carbon[effort=high]', label: 'Gemini 4 Carbon' },
        { id: 'Orchestrator (Carbon)', label: 'Orchestrator (Carbon)' }
      ]
    })
  })
})
