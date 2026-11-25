import { CLI_PROVIDERS, type AppState, type CliInfo, type ModelInfo } from '@shared/types'
import { CliError, EXIT_USAGE, type CliIo, type CliRuntime, type OutputFormat } from '../types'
import { parseProvider, writeJson } from './helpers'

export async function runCliCommand(
  runtime: CliRuntime,
  io: CliIo,
  sub: string | undefined,
  positionals: string[],
  opts: { format: OutputFormat; refresh?: boolean }
): Promise<number> {
  if (!sub || sub === 'list') {
    const rows: Array<{
      provider: string
      installed: boolean
      path?: string
      version?: string
      authStatus?: CliInfo['authStatus']
      source?: CliInfo['source']
    }> = []
    for (const provider of CLI_PROVIDERS) {
      const info = await runtime.call<CliInfo>('cli:info', provider, !!opts.refresh)
      rows.push({
        provider,
        installed: info.found,
        ...(info.path ? { path: info.path } : {}),
        ...(info.version ? { version: info.version } : {}),
        ...(info.authStatus ? { authStatus: info.authStatus } : {}),
        ...(info.source ? { source: info.source } : {})
      })
    }
    if (opts.format === 'json' || opts.format === 'jsonl') {
      writeJson(io, rows, opts.format)
      return 0
    }
    for (const r of rows) {
      const auth = r.authStatus ?? 'unknown'
      const ver = r.version ? ` v${r.version}` : ''
      io.stdout.write(`${r.provider.padEnd(12)} ${r.installed ? 'installed' : 'missing  '}  auth=${auth}${ver}${r.path ? `  ${r.path}` : ''}\n`)
    }
    return 0
  }

  if (sub === 'models') {
    const state = await runtime.call<AppState>('state:get')
    const provider = parseProvider(positionals[0], state.settings.cliProvider)
    const models = await runtime.call<ModelInfo[]>('cli:models', !!opts.refresh, provider)
    if (opts.format === 'json' || opts.format === 'jsonl') {
      writeJson(io, { provider, models }, opts.format)
      return 0
    }
    if (!models.length) {
      io.stdout.write(`No models returned for ${provider}.\n`)
      return 0
    }
    for (const m of models) {
      const label = m.label && m.label !== m.id ? `  ${m.label}` : ''
      io.stdout.write(`${m.id}${label}\n`)
    }
    return 0
  }

  throw new CliError(`Unknown "cli" subcommand: ${sub}. Expected "list" or "models".`, EXIT_USAGE)
}
