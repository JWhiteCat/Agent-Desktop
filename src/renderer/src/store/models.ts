import { normalizeCliProvider, type CliProvider, type ModelInfo } from '@shared/types'
import { errorText } from './feedback'
import { CLI_PROVIDERS, pruneCrossCliFavorites } from './model-preferences'
import { readModelCache, writeModelCache } from './persistence'
import { getState, setState } from './state'

function publishModels(cli: CliProvider, list: ModelInfo[]): void {
  const modelsByCli = { ...getState().modelsByCli, [cli]: list }
  const seen = new Set<string>()
  const models = [...modelsByCli.cursor, ...modelsByCli.codex, ...modelsByCli.claude].filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
  setState({ modelsByCli, models })
  pruneCrossCliFavorites()
}

export async function loadModels(refresh = false, only?: CliProvider): Promise<void> {
  const targets: CliProvider[] = only ? [only] : CLI_PROVIDERS
  if (!refresh) {
    for (const cli of targets) {
      const cached = readModelCache(cli)
      if (cached) publishModels(cli, cached)
    }
  }
  await Promise.all(
    targets.map(async (cli) => {
      try {
        const models = await window.api.listModels(refresh, cli)
        publishModels(cli, models)
        writeModelCache(cli, models)
        setModelError(cli, '')
      } catch (err) {
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
