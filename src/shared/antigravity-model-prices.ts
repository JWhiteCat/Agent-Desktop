import type { ModelPrice } from './model-prices'

/**
 * Antigravity CLI public API list prices, USD per million tokens. Verified 2026-11-18.
 * Sources:
 * - Gemini Developer API pricing: https://ai.google.dev/gemini-api/docs/pricing
 * - Google Cloud Generative AI pricing (Global Standard): https://cloud.google.com/vertex-ai/generative-ai/pricing
 * - Google Cloud Partner Models pricing (Global Standard): https://cloud.google.com/model-garden/partner-models/pricing
 * - Antigravity models & Gemini Enterprise reference: https://antigravity.google/docs/models and https://antigravity.google/docs/enterprise
 *
 * Gemini 4 Carbon and Gemini 4 Argon use introductory rates through 2026-11-30
 * ($2 input, $0.10 cache read, $10 output); from 2026-12-01 they are $4, $0.20, and $20.
 * Gemini 3.8 Flash, Gemini 3.7 Flash, and Gemini 3.6 Flash use introductory rates through 2026-12-31
 * ($0.75 input, $0.075 cache read, $3.75 output); from 2027-01-01 they are $1.50, $0.15, and $7.50.
 * Explicit cache writes on Gemini 4 Hydrogen are unbilled until 2027-01-12; Gemini 4 Carbon and Argon
 * use implicit caching only. Anthropic partner models use the 5-minute cache-write rate because ACP
 * reports cache writes as one count.
 *
 * Orchestrator options (`Orchestrator (Carbon)`, `Orchestrator (Argon)`) combine planner and
 * Gemini 4 Hydrogen turns into a single turn usage record without splitting tokens by model,
 * so they remain unpriced. These figures are Standard API rates, not Google AI Pro/Ultra
 * subscription charges or Gemini Enterprise seat credits.
 */
function rates(input: number, cacheRead: number, output: number, cacheWrite = 0): ModelPrice['rates'] {
  return { input, cacheRead, output, cacheWrite }
}

function model(ids: string[], label: string, rate: ModelPrice['rates']): ModelPrice {
  return {
    keys: [...new Set(ids.flatMap((id) => [id, id.replace(/\./g, '-'), id.replace(/(\d)-(\d)/g, '$1.$2')]))],
    label,
    rates: rate
  }
}

function tieredModel(
  ids: string[],
  label: string,
  rate: ModelPrice['rates'],
  longAfterTokens: number,
  long: ModelPrice['rates']
): ModelPrice {
  return { ...model(ids, label, rate), longAfterTokens, long }
}

const EFFORT_SUFFIX = /-(?:extra-low|extra-high|xhigh|minimal|medium|high|low|max|ultra|none)$/

const ANTIGRAVITY_PRICES: ModelPrice[] = [
  model(['gemini-4-carbon'], 'Gemini 4 Carbon', rates(2, 0.1, 10)),
  model(['gemini-4-argon'], 'Gemini 4 Argon', rates(2, 0.1, 10)),
  model(['gemini-4-hydrogen'], 'Gemini 4 Hydrogen', rates(1.5, 0.075, 7.5)),
  model(['gemini-3.8-flash'], 'Gemini 3.8 Flash', rates(0.75, 0.075, 3.75)),
  model(['gemini-3.7-flash'], 'Gemini 3.7 Flash', rates(0.75, 0.075, 3.75)),
  model(['gemini-3.6-flash'], 'Gemini 3.6 Flash', rates(0.75, 0.075, 3.75)),
  model(['gemini-3.5-flash-lite'], 'Gemini 3.5 Flash-Lite', rates(0.3, 0.03, 2.5)),
  model(['gemini-3.5-flash'], 'Gemini 3.5 Flash', rates(1.5, 0.15, 9)),
  tieredModel(['gemini-3.1-pro', 'gemini-3.1-pro-preview'], 'Gemini 3.1 Pro', rates(2, 0.2, 12), 200_000, rates(4, 0.4, 18)),
  model(['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview'], 'Gemini 3.1 Flash-Lite', rates(0.25, 0.025, 1.5)),
  model(['gemini-3-flash', 'gemini-3-flash-preview'], 'Gemini 3 Flash', rates(0.5, 0.05, 3)),
  tieredModel(['gemini-2.5-pro'], 'Gemini 2.5 Pro', rates(1.25, 0.125, 10), 200_000, rates(2.5, 0.25, 15)),
  model(['gemini-2.5-flash-lite'], 'Gemini 2.5 Flash-Lite', rates(0.1, 0.01, 0.4)),
  model(['gemini-2.5-flash'], 'Gemini 2.5 Flash', rates(0.3, 0.03, 2.5)),

  model(['claude-opus-5-5'], 'Claude Opus 5.5', rates(4, 0.2, 20, 5)),
  model(['claude-sonnet-5-5'], 'Claude Sonnet 5.5', rates(2, 0.1, 10, 2.5)),
  model(['claude-opus-4-6'], 'Claude Opus 4.6', rates(5, 0.5, 25, 6.25)),
  model(['claude-sonnet-4-6'], 'Claude Sonnet 4.6', rates(3, 0.3, 15, 3.75)),

  model(['gpt-oss-120b', 'gpt-oss-120b-maas'], 'GPT-OSS 120B', rates(0.09, 0, 0.36)),
  model(['gpt-oss-20b', 'gpt-oss-20b-maas'], 'GPT-OSS 20B', rates(0.07, 0.007, 0.25))
]

/**
 * Accepts Antigravity base ids, effort-suffixed CLI slugs (`gemini-4-carbon-high`,
 * `claude-opus-5-5-max`), Vertex `@default` / `@YYYYMMDD` tags, and gateway prefixes
 * (`models/agy/gemini-4-carbon-high`), while rejecting Orchestrator and unknown suffixes.
 */
export function findAntigravityPrice(name: string): ModelPrice | undefined {
  let id = name.replace(/\[[^\]]*\]/g, '').trim().toLowerCase()
  if (!id || id.includes('orchestrator')) return undefined
  if (id.startsWith('models/')) id = id.slice('models/'.length)
  if (id.startsWith('agy/') || id.startsWith('openai/') || id.startsWith('anthropic/') || id.startsWith('google/')) {
    id = id.slice(id.indexOf('/') + 1)
  }
  id = id.replace(/@(?:default|\d{8})$/, '').replace(/-thinking$/, '')
  const stripped = id.replace(EFFORT_SUFFIX, '')
  return ANTIGRAVITY_PRICES.find((entry) => entry.keys.includes(id) || (stripped !== id && entry.keys.includes(stripped)))
}
