import { sanitizeCommandCache, type CommandCache } from '@shared/commands'
import type { CliProvider, ModelInfo } from '@shared/types'

const COMMANDS_KEY = 'agent-desktop:slash-commands'
const MODELS_KEY = 'agent-desktop:models'
export const LAST_PROJECT_KEY = 'agent-desktop:lastProject'
export const LEGACY_MODEL_KEY = 'agent-desktop:model'

export function readCommandCache(): CommandCache {
  try {
    if (typeof localStorage === 'undefined') return {}
    return sanitizeCommandCache(JSON.parse(localStorage.getItem(COMMANDS_KEY) ?? 'null'))
  } catch {
    return {}
  }
}

export function writeCommandCache(cache: CommandCache): void {
  try {
    localStorage.setItem(COMMANDS_KEY, JSON.stringify(cache))
  } catch {
    /* Storage can be unavailable. The in-memory list still works for this run. */
  }
}

function modelCacheKey(cli: CliProvider): string {
  return cli === 'cursor' ? MODELS_KEY : `${MODELS_KEY}:${cli}`
}

export function readModelCache(cli: CliProvider): ModelInfo[] | null {
  try {
    const cached = JSON.parse(localStorage.getItem(modelCacheKey(cli)) ?? 'null') as ModelInfo[] | null
    return cached?.length ? cached : null
  } catch {
    return null
  }
}

export function writeModelCache(cli: CliProvider, models: ModelInfo[]): void {
  if (models.length > (cli === 'cursor' ? 1 : 0)) localStorage.setItem(modelCacheKey(cli), JSON.stringify(models))
}
