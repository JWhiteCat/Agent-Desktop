/**
 * Cursor list prices from https://cursor.com/docs/models-and-pricing (USD per million tokens).
 * Codex uses the separate OpenAI API price table in codex-model-prices.ts, Claude Code the Anthropic one in claude-model-prices.ts.
 * These are published API rates, not remaining included usage, and they omit the Teams token rate.
 * A cache-write cell of "-" is stored as 0.
 */

import { findClaudePrice } from './claude-model-prices'
import { findCodexPrice } from './codex-model-prices'
import { t } from './i18n'
import type { CliProvider } from './types'

export interface TokenCounts {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface TokenUsage extends TokenCounts {
  /** Individual requests within the turn, used to apply context pricing per request. */
  requests?: TokenCounts[]
}

export interface QuotedUsage {
  label: string
  /** Null when this model has no published price. */
  costUsd: number | null
  fast: boolean
  longContext: boolean
}

interface TokenRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelPrice {
  keys: string[]
  label: string
  rates: TokenRates
  fast?: TokenRates
  /** Input plus cache tokens above this count use the long-context rates. */
  longAfterTokens?: number
  long?: TokenRates
  fastLong?: TokenRates
}

const M = 1_000_000

function rates(input: number, cacheRead: number, output: number, cacheWrite = 0): TokenRates {
  return { input, output, cacheRead, cacheWrite }
}

function scale(r: TokenRates, factor: number): TokenRates {
  return {
    input: r.input * factor,
    output: r.output * factor,
    cacheRead: r.cacheRead * factor,
    cacheWrite: r.cacheWrite * factor
  }
}

/** Double the input side (input, cache read, cache write) and leave output as-is. */
function scaleInput(r: TokenRates, factor: number): TokenRates {
  return {
    input: r.input * factor,
    output: r.output,
    cacheRead: r.cacheRead * factor,
    cacheWrite: r.cacheWrite * factor
  }
}

const sonnet4 = rates(3, 0.3, 15, 3.75)
const gpt54 = rates(2.5, 0.25, 15)
const gpt55 = rates(5, 0.5, 30)
const luna = rates(0.2, 0.02, 1.2, 0.25)
const sol = rates(4, 0.4, 20, 5)
const terra = rates(2, 0.2, 12, 2.5)

/** GPT-5.6 states long context above 272k tokens. 5.4 and 5.5 use the same cutoff. */
const GPT_LONG = 272_000

function gptLong(base: TokenRates): Pick<ModelPrice, 'longAfterTokens' | 'fast' | 'long' | 'fastLong'> {
  const fast = scale(base, 2)
  return {
    longAfterTokens: GPT_LONG,
    fast,
    long: scaleInput(base, 2),
    fastLong: { ...scaleInput(fast, 2), output: fast.output }
  }
}

const PRICES: ModelPrice[] = [
  {
    keys: ['grok-4.7'],
    label: 'Grok 4.7',
    rates: rates(2, 0.5, 6),
    fast: rates(4, 1, 12),
    longAfterTokens: 256_000,
    long: rates(4, 1, 12),
    fastLong: rates(6, 1.5, 18)
  },
  { keys: ['grok-4.6'], label: 'Grok 4.6', rates: rates(2, 0.5, 6), fast: rates(4, 1, 12) },
  { keys: ['grok-4.5'], label: 'Grok 4.5', rates: rates(2, 0.5, 6), fast: rates(4, 1, 18) },
  { keys: ['composer-2.5', 'composer-2-5'], label: 'Composer 2.5', rates: rates(0.5, 0.2, 2.5), fast: rates(3, 0.5, 15) },

  { keys: ['claude-4-sonnet', 'claude-sonnet-4', 'claude-4.0-sonnet'], label: 'Claude 4 Sonnet', rates: sonnet4 },
  {
    keys: ['claude-4-sonnet-1m', 'claude-sonnet-4-1m', 'claude-4-sonnet-1-m'],
    label: 'Claude 4 Sonnet 1M',
    rates: sonnet4,
    longAfterTokens: 200_000,
    long: rates(6, 0.6, 22.5, 7.5)
  },
  { keys: ['claude-4.5-haiku', 'claude-haiku-4.5', 'claude-haiku-4-5'], label: 'Claude 4.5 Haiku', rates: rates(1, 0.1, 5, 1.25) },
  { keys: ['claude-4.5-opus', 'claude-opus-4.5', 'claude-opus-4-5'], label: 'Claude 4.5 Opus', rates: rates(5, 0.5, 25, 6.25) },
  { keys: ['claude-4.5-sonnet', 'claude-sonnet-4.5', 'claude-sonnet-4-5'], label: 'Claude 4.5 Sonnet', rates: rates(3, 0.3, 15, 3.75) },
  { keys: ['claude-4.6-opus', 'claude-opus-4.6', 'claude-opus-4-6'], label: 'Claude 4.6 Opus', rates: rates(5, 0.5, 25, 6.25) },
  { keys: ['claude-4.6-sonnet', 'claude-sonnet-4.6', 'claude-sonnet-4-6'], label: 'Claude 4.6 Sonnet', rates: rates(3, 0.3, 15, 3.75) },
  {
    keys: ['claude-4.7-opus', 'claude-opus-4.7', 'claude-opus-4-7'],
    label: 'Claude 4.7 Opus',
    rates: rates(5, 0.5, 25, 6.25),
    fast: rates(30, 3, 150, 37.5)
  },
  { keys: ['claude-fable-5'], label: 'Claude Fable 5', rates: rates(10, 1, 50, 12.5) },
  { keys: ['claude-fable-5.1', 'claude-fable-5-1'], label: 'Claude Fable 5.1', rates: rates(10, 0.25, 50, 12.5) },
  {
    keys: ['claude-opus-4.8', 'claude-opus-4-8', 'claude-4.8-opus'],
    label: 'Claude Opus 4.8',
    rates: rates(5, 0.5, 25, 6.25),
    fast: rates(10, 1, 50, 12.5)
  },
  { keys: ['claude-opus-5'], label: 'Claude Opus 5', rates: rates(5, 0.5, 25, 6.25) },
  { keys: ['claude-opus-5.5', 'claude-opus-5-5'], label: 'Claude Opus 5.5', rates: rates(4, 0.2, 20, 5) },
  { keys: ['claude-sonnet-5'], label: 'Claude Sonnet 5', rates: rates(2, 0.2, 10, 2.5) },

  { keys: ['gemini-2.5-flash', 'gemini-2-5-flash'], label: 'Gemini 2.5 Flash', rates: rates(0.3, 0.03, 2.5) },
  { keys: ['gemini-3-flash'], label: 'Gemini 3 Flash', rates: rates(0.5, 0.05, 3) },
  { keys: ['gemini-3-pro-image', 'gemini-3-pro-image-preview'], label: 'Gemini 3 Pro Image', rates: rates(2, 0.2, 12) },
  { keys: ['gemini-3-pro'], label: 'Gemini 3 Pro', rates: rates(2, 0.2, 12) },
  { keys: ['gemini-3.1-pro', 'gemini-3-1-pro'], label: 'Gemini 3.1 Pro', rates: rates(2, 0.2, 12) },
  { keys: ['gemini-3.5-flash', 'gemini-3-5-flash'], label: 'Gemini 3.5 Flash', rates: rates(1.5, 0.15, 9) },
  { keys: ['gemini-3.6-flash', 'gemini-3-6-flash'], label: 'Gemini 3.6 Flash', rates: rates(1.5, 0.15, 7.5) },
  { keys: ['gemini-3.7-flash', 'gemini-3-7-flash'], label: 'Gemini 3.7 Flash', rates: rates(0.75, 0.075, 3.5) },
  { keys: ['gemini-3.8-flash', 'gemini-3-8-flash'], label: 'Gemini 3.8 Flash', rates: rates(0.75, 0.075, 3.5) },

  { keys: ['glm-5.2', 'glm-5-2'], label: 'GLM 5.2', rates: rates(1.4, 0.26, 4.4) },

  { keys: ['gpt-5-mini'], label: 'GPT-5 Mini', rates: rates(0.25, 0.025, 2) },
  { keys: ['gpt-5-codex'], label: 'GPT-5 Codex', rates: rates(1.25, 0.125, 10) },
  { keys: ['gpt-5'], label: 'GPT-5', rates: rates(1.25, 0.125, 10), fast: rates(2.5, 0.25, 20) },
  { keys: ['gpt-5.1-codex-mini', 'gpt-5-1-codex-mini'], label: 'GPT-5.1 Codex Mini', rates: rates(0.25, 0.025, 2) },
  { keys: ['gpt-5.1-codex-max', 'gpt-5-1-codex-max'], label: 'GPT-5.1 Codex Max', rates: rates(1.25, 0.125, 10) },
  { keys: ['gpt-5.1-codex', 'gpt-5-1-codex'], label: 'GPT-5.1 Codex', rates: rates(1.25, 0.125, 10) },
  { keys: ['gpt-5.2-codex', 'gpt-5-2-codex'], label: 'GPT-5.2 Codex', rates: rates(1.75, 0.175, 14) },
  { keys: ['gpt-5.2', 'gpt-5-2'], label: 'GPT-5.2', rates: rates(1.75, 0.175, 14) },
  { keys: ['gpt-5.3-codex', 'gpt-5-3-codex'], label: 'GPT-5.3 Codex', rates: rates(1.75, 0.175, 14) },
  { keys: ['gpt-5.4-mini', 'gpt-5-4-mini'], label: 'GPT-5.4 Mini', rates: rates(0.75, 0.075, 4.5) },
  { keys: ['gpt-5.4-nano', 'gpt-5-4-nano'], label: 'GPT-5.4 Nano', rates: rates(0.2, 0.02, 1.25) },
  { keys: ['gpt-5.4-codex', 'gpt-5-4-codex'], label: 'GPT-5.4 Codex', rates: gpt54, ...gptLong(gpt54) },
  { keys: ['gpt-5.4', 'gpt-5-4'], label: 'GPT-5.4', rates: gpt54, ...gptLong(gpt54) },
  { keys: ['gpt-5.5-codex', 'gpt-5-5-codex'], label: 'GPT-5.5 Codex', rates: gpt55, longAfterTokens: GPT_LONG, long: scaleInput(gpt55, 2) },
  { keys: ['gpt-5.5', 'gpt-5-5'], label: 'GPT-5.5', rates: gpt55, longAfterTokens: GPT_LONG, long: scaleInput(gpt55, 2) },
  { keys: ['gpt-5.6-luna', 'gpt-5-6-luna'], label: 'GPT-5.6 Luna', rates: luna, ...gptLong(luna) },
  { keys: ['gpt-5.6-sol', 'gpt-5-6-sol'], label: 'GPT-5.6 Sol', rates: sol, ...gptLong(sol) },
  { keys: ['gpt-5.6-terra', 'gpt-5-6-terra'], label: 'GPT-5.6 Terra', rates: terra, ...gptLong(terra) },

  { keys: ['kimi-k2.7-code', 'kimi-k2-7-code'], label: 'Kimi K2.7 Code', rates: rates(0.95, 0.19, 4) },
  { keys: ['kimi-k3'], label: 'Kimi K3', rates: rates(3, 0.3, 15) },
  { keys: ['muse-spark-1.3', 'muse-spark-1-3'], label: 'Muse Spark 1.3', rates: rates(1.25, 0.15, 4.25) }
]

const KEYS = PRICES.flatMap((entry) => entry.keys.map((key) => ({ key, entry }))).sort((a, b) => b.key.length - a.key.length)

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function parseModelId(id: string): { name: string; fast: boolean } {
  let name = id.trim()
  let fast = false
  const bracket = name.match(/^([^[]+)\[([^\]]*)\]$/)
  if (bracket) {
    name = bracket[1]
    const params = bracket[2]
    fast = /(?:^|,)\s*fast\s*=\s*true\b/i.test(params)
      || /(?:^|,)\s*speed\s*=\s*fast\b/i.test(params)
      || /(?:^|,)\s*service_tier\s*=\s*(?:fast|priority)\b/i.test(params)
  }
  name = name.trim().toLowerCase()
  if (name.endsWith('-fast')) {
    fast = true
    name = name.slice(0, -5)
  }
  return { name, fast }
}

function findPrice(name: string): ModelPrice | undefined {
  return KEYS.find(({ key }) => name === key || name.startsWith(`${key}-`))?.entry
}

function pickRates(entry: ModelPrice, fast: boolean, long: boolean): TokenRates {
  if (fast && long) return entry.fastLong ?? entry.long ?? entry.fast ?? entry.rates
  if (long) return entry.long ?? entry.rates
  if (fast) return entry.fast ?? entry.rates
  return entry.rates
}

function roundUsd(n: number): number {
  return Math.round(n * 1e8) / 1e8
}

/** Published list price for one turn. `auto` and unknown models have no price. */
export function quoteModel(modelId: string | undefined, usage: TokenUsage, cli: CliProvider = 'cursor'): QuotedUsage {
  const parsed = parseModelId(modelId ?? '')
  const fallback = !parsed.name ? t('未知模型') : parsed.name === 'auto' ? 'Auto' : (modelId ?? '').trim() || t('未知模型')
  if (!parsed.name || parsed.name === 'auto') {
    return { label: fallback, costUsd: null, fast: parsed.fast, longContext: false }
  }
  const entry = cli === 'codex' ? findCodexPrice(parsed.name) : cli === 'claude' ? findClaudePrice(parsed.name) : findPrice(parsed.name)
  if (!entry) return { label: fallback, costUsd: null, fast: parsed.fast, longContext: false }

  const requests = usage.requests?.length ? usage.requests : [usage]
  let long = false
  let priced = true
  let cost = 0
  for (const request of requests) {
    const inputSide = num(request.inputTokens) + num(request.cacheReadTokens) + num(request.cacheWriteTokens)
    const requestLong = entry.longAfterTokens != null && inputSide > entry.longAfterTokens
    long ||= requestLong
    // A tier with no published OpenAI or Anthropic price must not silently inherit Standard pricing.
    if (cli !== 'cursor' && parsed.fast && !(requestLong ? entry.fastLong : entry.fast)) priced = false
    const rate = pickRates(entry, parsed.fast, requestLong)
    cost +=
      (num(request.inputTokens) * rate.input +
        num(request.outputTokens) * rate.output +
        num(request.cacheReadTokens) * rate.cacheRead +
        num(request.cacheWriteTokens) * rate.cacheWrite) /
      M
  }
  const bits = [entry.label]
  if (parsed.fast) bits.push('Fast')
  if (long) bits.push(t('长上下文'))
  return { label: bits.join(' '), costUsd: priced ? roundUsd(cost) : null, fast: parsed.fast, longContext: long }
}
