import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const isWin = process.platform === 'win32'
const processGroups = new WeakSet<ChildProcess>()
const terminating = new WeakSet<ChildProcess>()

/** File-picker paths may be quoted or pasted with a home-directory shorthand. */
export function normalizeCliPath(value: string): string {
  const trimmed = value.trim()
  const unquoted = trimmed.replace(isWin ? /^"(.*)"$/ : /^(?:"(.*)"|'(.*)')$/, (_match, double, single) => double ?? single)
  return unquoted === '~' ? os.homedir() : unquoted.startsWith('~/') ? path.join(os.homedir(), unquoted.slice(2)) : unquoted
}

/** Desktop launchers do not usually inherit the PATH configured in a terminal. */
export function cliSearchDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  const inherited = (env.PATH ?? '').split(path.delimiter).map(normalizeCliPath).filter(Boolean)
  if (isWin) return [...new Set(inherited)]
  const home = os.homedir()
  const prefixBin = (value: string | undefined): string | undefined => {
    const prefix = normalizeCliPath(value ?? '')
    return prefix ? path.join(prefix, 'bin') : undefined
  }
  const extra = [
    prefixBin(env.NPM_CONFIG_PREFIX || env.npm_config_prefix),
    normalizeCliPath(env.NVM_BIN ?? ''),
    normalizeCliPath(env.PNPM_HOME ?? ''),
    prefixBin(env.VOLTA_HOME),
    prefixBin(env.HOMEBREW_PREFIX),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.npm', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.linuxbrew', 'bin'),
    '/home/linuxbrew/.linuxbrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin'
  ]
  // Preserve a terminal's explicit version selection and never add an empty
  // component (which would implicitly search the project's working directory).
  return [...new Set([...inherited, ...extra.filter((dir): dir is string => !!dir)])]
}

export function cliEnvironment(extraEnv: NodeJS.ProcessEnv = {}, executableDirectory?: string): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extraEnv }
  if (!isWin) {
    const directories = [...(executableDirectory ? [executableDirectory] : []), ...cliSearchDirectories(env)]
    env.PATH = [...new Set(directories)].join(path.delimiter)
  }
  return env
}

/** Check regular files and executable symlink targets, not just their existence. */
export function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, isWin ? fs.constants.F_OK : fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Accept a binary, its bin directory, or an installation prefix containing bin/. */
export function findCliExecutable(value: string, names: string[]): string | undefined {
  const file = normalizeCliPath(value)
  try {
    if (fs.statSync(file).isDirectory()) {
      for (const dir of [file, path.join(file, 'bin')]) {
        for (const name of names) {
          const candidate = path.join(dir, name)
          if (isExecutableFile(candidate)) return path.resolve(candidate)
        }
      }
      return undefined
    }
    return isExecutableFile(file) ? path.resolve(file) : undefined
  } catch {
    return undefined
  }
}

/** A private POSIX process group keeps adapter, CLI and tool descendants together. */
export function spawnCliProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, args, { ...options, detached: !isWin })
  if (!isWin) processGroups.add(child)
  return child
}

export function killCliProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || terminating.has(child)) return
  if (isWin) {
    if (child.exitCode !== null || child.signalCode !== null) return
    terminating.add(child)
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    return
  }
  if (processGroups.has(child)) {
    const group = -child.pid
    try {
      process.kill(group, 'SIGTERM')
    } catch {
      // The group can already be gone, including after an unsuccessful spawn.
      return
    }
    terminating.add(child)
    const timer = setTimeout(() => {
      // The adapter may have exited while a tool still owns the inherited pipes.
      // Do not gate escalation on the adapter's exitCode or signalCode.
      try { process.kill(group, 'SIGKILL') } catch { /* already gone */ }
    }, 3000)
    timer.unref()
  } else if (child.exitCode === null && child.signalCode === null) {
    // Only target a group that we created; callers may also pass an ordinary child.
    terminating.add(child)
    child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 3000)
    timer.unref()
  }
}
