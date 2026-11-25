import { CLI_PROVIDERS, type AppState, type CliInfo } from '@shared/types'
import { writeJson } from './helpers'
import type { CliIo, CliRuntime, OutputFormat } from '../types'

export async function runStatus(
  runtime: CliRuntime,
  io: CliIo,
  opts: { format: OutputFormat }
): Promise<number> {
  const state = await runtime.call<AppState>('state:get')
  const clis: Record<string, { installed: boolean; path?: string; version?: string; authStatus?: string; source?: string }> = {}
  for (const provider of CLI_PROVIDERS) {
    try {
      const info = await runtime.call<CliInfo>('cli:info', provider, false)
      clis[provider] = {
        installed: info.found,
        ...(info.path ? { path: info.path } : {}),
        ...(info.version ? { version: info.version } : {}),
        ...(info.authStatus ? { authStatus: info.authStatus } : {}),
        ...(info.source ? { source: info.source } : {})
      }
    } catch {
      clis[provider] = { installed: false }
    }
  }

  const payload = {
    mode: runtime.mode,
    dataDir: runtime.dataDir,
    ...(runtime.desktopPid ? { desktopPid: runtime.desktopPid } : {}),
    ...(runtime.appVersion ? { appVersion: runtime.appVersion } : {}),
    projects: state.projects.length,
    threads: state.threads.length,
    running: state.running,
    waitingForInput: state.waitingForInput ?? [],
    defaultCli: state.settings.cliProvider,
    defaultMode: state.settings.defaultMode,
    clis
  }

  if (opts.format === 'json' || opts.format === 'jsonl') {
    writeJson(io, payload, opts.format)
    return 0
  }

  io.stdout.write(`Mode:       ${payload.mode}${payload.desktopPid ? ` (desktop PID ${payload.desktopPid})` : ''}\n`)
  io.stdout.write(`Data dir:   ${payload.dataDir}\n`)
  io.stdout.write(`Projects:   ${payload.projects}\n`)
  io.stdout.write(`Threads:    ${payload.threads} (${payload.running.length} running, ${payload.waitingForInput.length} waiting)\n`)
  io.stdout.write(`Defaults:   cli=${payload.defaultCli}, mode=${payload.defaultMode}\n`)
  io.stdout.write('Backends:\n')
  for (const provider of CLI_PROVIDERS) {
    const c = clis[provider]
    const status = c.installed ? `installed (${c.authStatus ?? 'unknown'})` : 'not installed'
    io.stdout.write(`  - ${provider.padEnd(12)} ${status}${c.path ? `  ${c.path}` : ''}\n`)
  }
  return 0
}
