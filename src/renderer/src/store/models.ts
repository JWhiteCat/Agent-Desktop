import { CLI_PROVIDERS, normalizeCliProvider, type CliProvider, type ModelInfo } from '@shared/types'
import { errorText } from './feedback'
import { pruneCrossCliFavorites } from './model-preferences'
import { readModelCache, writeModelCache } from './persistence'
import { getState, setState } from './state'

const modelRequests = new Map<CliProvider, symbol>()

function publishModels(cli: CliProvider, list: ModelInfo[]): void {
  const modelsByCli = { ...getState().modelsByCli, [cli]: list }
  const seen = new Set<string>()
  const models = CLI_PROVIDERS.flatMap((provider) => modelsByCli[provider]).filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
  setState({ modelsByCli, models })
  pruneCrossCliFavorites()
}

export async function loadModels(refresh = false, only?: CliProvider): Promise<void> {
  const targets = only ? [only] : CLI_PROVIDERS
  if (!refresh) {
    for (const cli of targets) {
      const cached = readModelCache(cli)
      if (cached) publishModels(cli, cached)
    }
  }
  await Promise.all(
    targets.map(async (cli) => {
      const request = Symbol()
      modelRequests.set(cli, request)
      try {
        const models = await window.api.listModels(refresh, cli)
        if (modelRequests.get(cli) !== request) return
        publishModels(cli, models)
        writeModelCache(cli, models)
        setModelError(cli, '')
      } catch (err) {
        if (modelRequests.get(cli) !== request) return
        const loaded = (getState().modelsByCli[cli]?.length ?? 0) > (cli === 'cursor' ? 1 : 0)
        setModelError(cli, loaded ? '' : errorText(err))
      }
    })
  )
}

function setModelError(cli: CliProvider, message: string): void {
  if (getState().modelErrorByCli[cli] === message) return
  setState((s) => ({ modelErrorByCli: { ...s.modelErrorByCli, [cli]: message } }))
}

/** Remember which CLI new conversations use. */
export function setCliProvider(cli: CliProvider): void {
  const next = normalizeCliProvider(cli)
  if (normalizeCliProvider(getState().app.settings.cliProvider) === next) return
  setState((s) => ({ app: { ...s.app, settings: { ...s.app.settings, cliProvider: next } } }))
  void window.api.updateSettings({ cliProvider: next })
  void loadModels(false, next)
}
