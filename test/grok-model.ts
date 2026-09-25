/**
 * Cursor catalog id for Grok 4.7, 500K context, high effort, Fast.
 * `agent models` collapses this to `grok-4.7-high-fast` and drops the context size,
 * so the live smoke test must pass the parameterized id.
 */
export const GROK_47_500K_HIGH_FAST = 'grok-4.7[context=500k,reasoning_effort=high,fast=true]'
