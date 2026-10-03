import type { ModelPrice } from './model-prices'

/**
 * OpenAI API list prices, USD per million tokens. Verified 2026-09-29; GPT-6.1 Sol verified 2026-10-04.
 * Source: https://developers.openai.com/api/docs/pricing (including All models).
 * GPT-6.1 Sol: https://developers.openai.com/api/docs/models/gpt-6.1-sol.
 * Older Codex models: https://developers.openai.com/api/docs/models/{model-id}.
 * Standard and Fast only; these estimates do not represent ChatGPT subscription charges.
 * Cache writes are separate tokens charged instead of regular input, not an extra fee.
 */
function rates(input: number, cacheRead: number, output: number, cacheWrite = 0): ModelPrice['rates'] {
  return { input, cacheRead, output, cacheWrite }
}

function model(id: string, label: string, rate: ModelPrice['rates']): ModelPrice {
  return { keys: [...new Set([id, id.replace(/\./g, '-')])], label, rates: rate }
}

function longRates(rate: ModelPrice['rates']): ModelPrice['rates'] {
  return { input: rate.input * 2, cacheRead: rate.cacheRead * 2, cacheWrite: rate.cacheWrite * 2, output: rate.output * 1.5 }
}

function fastModel(id: string, label: string, rate: ModelPrice['rates'], multiplier = 2): ModelPrice & { fast: ModelPrice['rates'] } {
  const fast = rates(rate.input * multiplier, rate.cacheRead * multiplier, rate.output * multiplier, rate.cacheWrite * multiplier)
  return { ...model(id, label, rate), fast }
}

function flagship(id: string, label: string, rate: ModelPrice['rates']): ModelPrice {
  const { fast } = fastModel(id, label, rate)
  return { ...model(id, label, rate), longAfterTokens: 272_000, long: longRates(rate), fast, fastLong: longRates(fast) }
}

const CODEX_PRICES: ModelPrice[] = [
  flagship('gpt-6.1-sol', 'GPT-6.1 Sol', rates(2, 0.1, 10, 2.5)),
  flagship('gpt-6-astra', 'GPT-6 Astra', rates(10, 1, 50, 12.5)),
  flagship('gpt-6-sol', 'GPT-6 Sol', rates(2, 0.2, 10, 2.5)),
  flagship('gpt-6-luna', 'GPT-6 Luna', rates(0.1, 0.01, 0.5, 0.125)),
  flagship('gpt-5.6-sol', 'GPT-5.6 Sol', rates(4, 0.4, 20, 5)),
  flagship('gpt-5.6-terra', 'GPT-5.6 Terra', rates(2, 0.2, 12, 2.5)),
  flagship('gpt-5.6-luna', 'GPT-5.6 Luna', rates(0.2, 0.02, 1.2, 0.25)),
  model('gpt-5.6-cyber', 'GPT-5.6 Cyber', rates(12.5, 1.25, 75, 15.625)),
  { ...fastModel('gpt-5.5', 'GPT-5.5', rates(5, 0.5, 30), 2.5), longAfterTokens: 272_000, long: rates(10, 1, 45) },
  { ...fastModel('gpt-5.4', 'GPT-5.4', rates(2.5, 0.25, 15)), longAfterTokens: 272_000, long: rates(5, 0.5, 22.5) },
  fastModel('gpt-5.4-mini', 'GPT-5.4 Mini', rates(0.75, 0.075, 4.5)),
  model('gpt-5.4-nano', 'GPT-5.4 Nano', rates(0.2, 0.02, 1.25)),
  fastModel('gpt-5.3-codex', 'GPT-5.3 Codex', rates(1.75, 0.175, 14)),
  model('gpt-5.2-codex', 'GPT-5.2 Codex', rates(1.75, 0.175, 14)),
  model('gpt-5.1-codex', 'GPT-5.1 Codex', rates(1.25, 0.125, 10)),
  model('gpt-5.1-codex-max', 'GPT-5.1 Codex Max', rates(1.25, 0.125, 10)),
  model('gpt-5.1-codex-mini', 'GPT-5.1 Codex Mini', rates(0.25, 0.025, 2)),
  model('gpt-5-codex', 'GPT-5 Codex', rates(1.25, 0.125, 10)),
  model('codex-mini-latest', 'Codex Mini', rates(1.5, 0.375, 6)),
  fastModel('gpt-5.2', 'GPT-5.2', rates(1.75, 0.175, 14)),
  fastModel('gpt-5.1', 'GPT-5.1', rates(1.25, 0.125, 10)),
  fastModel('gpt-5', 'GPT-5', rates(1.25, 0.125, 10)),
  fastModel('gpt-5-mini', 'GPT-5 Mini', rates(0.25, 0.025, 2), 1.8),
  model('gpt-5-nano', 'GPT-5 Nano', rates(0.05, 0.005, 0.4))
]

/** Accept exact model aliases and dated snapshots, never arbitrary suffixes such as -pro or -spark. */
export function findCodexPrice(name: string): ModelPrice | undefined {
  return CODEX_PRICES.find((entry) => entry.keys.some((key) =>
    name === key || (name.startsWith(`${key}-`) && /^\d{4}-\d{2}-\d{2}$/.test(name.slice(key.length + 1)))
  ))
}
