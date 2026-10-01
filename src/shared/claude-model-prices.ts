import type { ModelPrice } from './model-prices'

/**
 * Anthropic API list prices, USD per million tokens. Verified 2026-10-01.
 * Source: https://claude.com/pricing#api and https://platform.claude.com/docs/en/about-claude/pricing.
 * Cache writes use the 5-minute rate; the CLI reports 5m and 1h writes as one count.
 * Claude 4.6 and later bill the full 1M context at standard rates, so there is no long-context tier.
 * Fast mode, Batch and US-only inference are not distinguished in recorded usage and are not priced.
 */
function rates(input: number, cacheRead: number, output: number, cacheWrite: number): ModelPrice['rates'] {
  return { input, cacheRead, output, cacheWrite }
}

function model(ids: string[], label: string, rate: ModelPrice['rates']): ModelPrice {
  return { keys: [...new Set(ids.flatMap((id) => [id, id.replace(/(\d)-(\d)/g, '$1.$2')]))], label, rates: rate }
}

const opus4 = rates(15, 1.5, 75, 18.75)
const opus45 = rates(5, 0.5, 25, 6.25)
const sonnet4 = rates(3, 0.3, 15, 3.75)
const sonnet5 = rates(2, 0.2, 10, 2.5)

const CLAUDE_PRICES: ModelPrice[] = [
  model(['claude-fable-5-1'], 'Claude Fable 5.1', rates(10, 0.25, 50, 12.5)),
  model(['claude-mythos-5-1'], 'Claude Mythos 5.1', rates(10, 0.25, 50, 12.5)),
  model(['claude-fable-5'], 'Claude Fable 5', rates(10, 1, 50, 12.5)),
  model(['claude-mythos-5'], 'Claude Mythos 5', rates(10, 1, 50, 12.5)),
  model(['claude-opus-5-5'], 'Claude Opus 5.5', rates(4, 0.2, 20, 5)),
  model(['claude-opus-5'], 'Claude Opus 5', opus45),
  model(['claude-opus-4-8'], 'Claude Opus 4.8', opus45),
  model(['claude-opus-4-7'], 'Claude Opus 4.7', opus45),
  model(['claude-opus-4-6'], 'Claude Opus 4.6', opus45),
  model(['claude-opus-4-5'], 'Claude Opus 4.5', opus45),
  model(['claude-opus-4-1'], 'Claude Opus 4.1', opus4),
  model(['claude-opus-4', 'claude-opus-4-0'], 'Claude Opus 4', opus4),
  model(['claude-sonnet-5-5'], 'Claude Sonnet 5.5', sonnet5),
  model(['claude-sonnet-5'], 'Claude Sonnet 5', sonnet5),
  model(['claude-sonnet-4-6'], 'Claude Sonnet 4.6', sonnet4),
  model(['claude-sonnet-4-5'], 'Claude Sonnet 4.5', sonnet4),
  model(['claude-sonnet-4', 'claude-sonnet-4-0'], 'Claude Sonnet 4', sonnet4),
  model(['claude-haiku-4-5'], 'Claude Haiku 4.5', rates(1, 0.1, 5, 1.25)),
  model(['claude-3-5-haiku'], 'Claude Haiku 3.5', rates(0.8, 0.08, 4, 1))
]

/**
 * Accepts API ids and dated snapshots such as `claude-haiku-4-5-20251001`, ignoring `[1m]`-style hints.
 * Aliases like `opus` are not priced: they move to newer models, so old turns would be repriced.
 */
export function findClaudePrice(name: string): ModelPrice | undefined {
  const id = name.replace(/\[[^\]]*\]/g, '').trim().toLowerCase()
  return CLAUDE_PRICES.find((entry) => entry.keys.some((key) =>
    id === key || (id.startsWith(`${key}-`) && /^\d{8}$/.test(id.slice(key.length + 1)))
  ))
}
