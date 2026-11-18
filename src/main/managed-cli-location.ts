import fs from 'node:fs'
import path from 'node:path'
import type { CliProvider } from '@shared/types'
import { isExecutableFile } from './cli-runtime'

export type CliInstallTarget = CliProvider | 'antigravity-registry'

export interface ManagedExecutable {
  version: string
  command: string
  prefixArgs: string[]
}

let root: string | undefined

export function configureManagedCliDirectory(dataDirectory: string): void {
  root = path.join(dataDirectory, 'cli')
}

export function managedCliDirectory(target: CliInstallTarget): string | undefined {
  // Keep the old ACP Registry activation record for conversations that still use it.
  const directory = target === 'antigravity-registry' ? 'antigravity' : target === 'antigravity' ? 'antigravity-cli' : target
  return root && path.join(root, directory)
}

/** Paths in the activation record are relative to a version directory. */
export function installPath(directory: string, relative: unknown): string | undefined {
  if (typeof relative !== 'string' || !relative || /[\\:\u0000]/.test(relative)
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) return undefined
  return path.join(directory, ...relative.split('/'))
}

export function managedExecutable(provider: CliInstallTarget): ManagedExecutable | undefined {
  const directory = managedCliDirectory(provider)
  if (!directory) return undefined
  try {
    const record = JSON.parse(fs.readFileSync(path.join(directory, 'current.json'), 'utf8'))
    if (typeof record.version !== 'string' || typeof record.generation !== 'string'
      || !/^[a-zA-Z0-9.-]+-[a-f0-9-]{36}$/.test(record.generation) || !Array.isArray(record.prefixArgs)) return undefined
    const payload = path.join(directory, 'versions', record.generation)
    const command = installPath(payload, record.command)
    if (!command || !isExecutableFile(command)) return undefined
    // Cursor's legacy Windows distribution uses node.exe plus its JS entry. The
    // only other managed prefix is Google's published Linux runtime argument.
    const prefixArgs: string[] = []
    for (const arg of record.prefixArgs) {
      if (provider === 'antigravity-registry' && arg === '--uid=') prefixArgs.push(arg)
      else {
        const file = provider === 'cursor' ? installPath(payload, arg) : undefined
        if (!file || !fs.statSync(file).isFile()) return undefined
        prefixArgs.push(file)
      }
    }
    return { command, prefixArgs, version: record.version }
  } catch {
    return undefined
  }
}
