import { getRuntimeDataDir } from '../main/runtime-paths'
import { connectAttached } from './client'
import { HeadlessCliRuntime } from './headless'
import { CliError, EXIT_CONFLICT, EXIT_NOT_ATTACHED, EXIT_USAGE, type CliRuntime } from './types'

export interface OpenRuntimeOptions {
  userData?: string
  attachOnly?: boolean
  headless?: boolean
  command?: string
}

export async function openCliRuntime(opts: OpenRuntimeOptions = {}): Promise<CliRuntime> {
  if (opts.attachOnly && opts.headless) {
    throw new CliError('Cannot combine --attach-only and --headless', EXIT_USAGE)
  }
  const dataDir = getRuntimeDataDir(opts.userData)
  const attached = await connectAttached(dataDir)

  if (opts.headless) {
    if (attached) {
      await attached.close()
      throw new CliError(
        `Agent Desktop (PID ${attached.desktopPid}) is currently running on ${dataDir}. Omit --headless to attach to it safely.`,
        EXIT_CONFLICT
      )
    }
    return new HeadlessCliRuntime(dataDir, opts.command)
  }

  if (attached) return attached

  if (opts.attachOnly) {
    throw new CliError(
      `Agent Desktop is not running for data directory ${dataDir} (--attach-only was specified).`,
      EXIT_NOT_ATTACHED
    )
  }

  return new HeadlessCliRuntime(dataDir, opts.command)
}
