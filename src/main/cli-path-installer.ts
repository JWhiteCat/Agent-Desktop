import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as electron from 'electron'
import type { AppCliPathStatus } from '@shared/types'

export const APP_CLI_COMMANDS = ['agent-desktop', 'agd'] as const
const MANAGED_MARKER = '# Managed by Agent Desktop CLI'

export interface PathInstallerEnv {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  homeDir: string
  isPackaged: boolean
  execPath: string
  resourcesPath: string
  appPath: string
  dataDir: string
  readWinUserPath?: () => string
  writeWinUserPath?: (nextPath: string) => void
  isPosixExecutable?: (filePath: string) => boolean
  chmodPosix?: (filePath: string, mode: number) => void
}

function defaultEnv(dataDir: string): PathInstallerEnv {
  const app = (electron as { app?: { isPackaged?: boolean; getAppPath?: () => string } }).app
  return {
    platform: process.platform,
    env: process.env,
    homeDir: os.homedir(),
    isPackaged: Boolean(app?.isPackaged),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath ?? '',
    appPath: app?.getAppPath?.() ?? process.cwd(),
    dataDir
  }
}

function normalizeWinDir(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
}

function splitPathEntries(raw: string | undefined, sep: string): string[] {
  if (!raw) return []
  return raw.split(sep).map((s) => s.trim()).filter(Boolean)
}

function isDirInEnvPath(dir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const sep = platform === 'win32' ? ';' : ':'
  const entries = splitPathEntries(env.PATH ?? env.Path, sep)
  if (platform === 'win32') {
    const target = normalizeWinDir(dir)
    return entries.some((e) => normalizeWinDir(e) === target)
  }
  const target = path.resolve(dir)
  return entries.some((e) => path.resolve(e) === target)
}

function readWindowsUserPath(): string {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetEnvironmentVariable("Path", "User")'],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 }
  )
  return out.replace(/\r?\n$/, '')
}

function writeWindowsUserPath(nextPath: string): void {
  // Pass via environment variable so special characters / quotes never break PowerShell parsing.
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::SetEnvironmentVariable("Path", $env:AD_NEXT_USER_PATH, "User")'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, AD_NEXT_USER_PATH: nextPath }
    }
  )
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function resolveCliEntry(ctx: PathInstallerEnv): string {
  if (ctx.isPackaged) {
    return path.join(ctx.resourcesPath, 'cli', 'cli.cjs')
  }
  return path.join(ctx.appPath, 'out', 'main', 'cli.cjs')
}

function isWindowsAgentDesktopBinEntry(entry: string): boolean {
  const norm = normalizeWinDir(entry)
  if (norm.endsWith('\\resources\\bin')) {
    return fs.existsSync(path.join(entry, 'agent-desktop.cmd')) || norm.includes('agent desktop') || norm.includes('agent-desktop')
  }
  if (norm.endsWith('\\data\\bin')) {
    return fs.existsSync(path.join(entry, 'agent-desktop.cmd'))
  }
  return false
}

function ensureDevWindowsShims(ctx: PathInstallerEnv): string {
  const binDir = path.join(ctx.dataDir, 'bin')
  const cliEntry = resolveCliEntry(ctx)
  fs.mkdirSync(binDir, { recursive: true })
  const cmdContent = [
    '@echo off',
    'setlocal',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"${ctx.execPath}" "${cliEntry}" %*`,
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n')
  const aliasCmd = ['@echo off', 'call "%~dp0agent-desktop.cmd" %*', 'exit /b %ERRORLEVEL%', ''].join('\r\n')
  const shContent = [
    '#!/usr/bin/env bash',
    MANAGED_MARKER,
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(ctx.execPath)} ${shellQuote(cliEntry)} "$@"`,
    ''
  ].join('\n')
  const aliasSh = [
    '#!/usr/bin/env bash',
    MANAGED_MARKER,
    'DIR="$(cd -P "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"',
    'exec "$DIR/agent-desktop" "$@"',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(binDir, 'agent-desktop.cmd'), cmdContent, 'utf8')
  fs.writeFileSync(path.join(binDir, 'agd.cmd'), aliasCmd, 'utf8')
  fs.writeFileSync(path.join(binDir, 'agent-desktop'), shContent, 'utf8')
  fs.writeFileSync(path.join(binDir, 'agd'), aliasSh, 'utf8')
  return binDir
}

function isWritableDir(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function resolvePosixTargetDir(ctx: PathInstallerEnv): string {
  const localBin = path.join(ctx.homeDir, '.local', 'bin')
  if (ctx.platform === 'darwin') {
    const usrLocalBin = '/usr/local/bin'
    // Prefer /usr/local/bin if already writable (standard macOS PATH); otherwise fall back to ~/.local/bin.
    if (fs.existsSync(usrLocalBin) && isWritableDir(usrLocalBin)) return usrLocalBin
  }
  return localBin
}

function defaultIsPosixExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function inspectPosixCommand(
  filePath: string,
  isExecutable: (p: string) => boolean = defaultIsPosixExecutable
): { exists: boolean; managed: boolean; valid: boolean; target?: string } {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(filePath)
  } catch {
    return { exists: false, managed: false, valid: false }
  }
  if (stat.isSymbolicLink()) {
    const rawTarget = fs.readlinkSync(filePath)
    const resolved = path.resolve(path.dirname(filePath), rawTarget)
    const looksOurs = resolved.includes('Agent Desktop') || resolved.includes('agent-desktop') || resolved.endsWith('/bin/agent-desktop') || resolved.endsWith('/bin/agd')
    return {
      exists: true,
      managed: looksOurs,
      valid: fs.existsSync(resolved) && isExecutable(resolved),
      target: resolved
    }
  }
  if (stat.isFile()) {
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      if (!content.includes(MANAGED_MARKER)) {
        return { exists: true, managed: false, valid: true }
      }
      const match = /exec\s+'([^']+)'/.exec(content)
      const target = match?.[1]
      return {
        exists: true,
        managed: true,
        valid: (target ? fs.existsSync(target) : true) && isExecutable(filePath),
        target
      }
    } catch {
      return { exists: true, managed: false, valid: false }
    }
  }
  return { exists: true, managed: false, valid: false }
}

function isPortableBuild(ctx: PathInstallerEnv): boolean {
  return Boolean(ctx.env.PORTABLE_EXECUTABLE_DIR || ctx.env.APPIMAGE)
}

export function getAppCliPathStatus(dataDir: string, override?: Partial<PathInstallerEnv>): AppCliPathStatus {
  const ctx: PathInstallerEnv = { ...defaultEnv(dataDir), ...override }
  const cliEntry = resolveCliEntry(ctx)
  const commands = [...APP_CLI_COMMANDS]

  if (ctx.platform === 'win32') {
    const sourceDir = ctx.isPackaged ? path.join(ctx.resourcesPath, 'bin') : path.join(ctx.dataDir, 'bin')
    const cliReady = fs.existsSync(cliEntry)
    if (!cliReady && !ctx.isPackaged) {
      return {
        commands,
        supported: false,
        state: 'unsupported',
        sourcePath: sourceDir,
        inPath: false,
        isPortable: isPortableBuild(ctx),
        error: 'CLI bundle not built (run npm run build first)'
      }
    }
    const readPath = ctx.readWinUserPath ?? readWindowsUserPath
    let userPath = ''
    try {
      userPath = readPath()
    } catch {
      userPath = ctx.env.PATH ?? ctx.env.Path ?? ''
    }
    const entries = splitPathEntries(userPath, ';')
    const targetNorm = normalizeWinDir(sourceDir)
    const exactMatch = entries.find((e) => normalizeWinDir(e) === targetNorm)
    const anyOurs = exactMatch ?? entries.find((e) => isWindowsAgentDesktopBinEntry(e))

    if (exactMatch && fs.existsSync(path.join(sourceDir, 'agent-desktop.cmd')) && fs.existsSync(path.join(sourceDir, 'agd.cmd'))) {
      return {
        commands,
        supported: true,
        state: 'installed',
        targetPath: sourceDir,
        sourcePath: sourceDir,
        inPath: true,
        isPortable: isPortableBuild(ctx)
      }
    }
    if (anyOurs) {
      return {
        commands,
        supported: true,
        state: 'stale',
        targetPath: anyOurs,
        sourcePath: sourceDir,
        inPath: isDirInEnvPath(anyOurs, ctx.env, 'win32'),
        isPortable: isPortableBuild(ctx)
      }
    }
    return {
      commands,
      supported: true,
      state: 'not-installed',
      targetPath: sourceDir,
      sourcePath: sourceDir,
      inPath: false,
      isPortable: isPortableBuild(ctx)
    }
  }

  // macOS & Linux
  const sourceDir = ctx.isPackaged ? path.join(ctx.resourcesPath, 'bin') : path.join(ctx.dataDir, 'bin')
  if (!ctx.isPackaged && !fs.existsSync(cliEntry)) {
    return {
      commands,
      supported: false,
      state: 'unsupported',
      sourcePath: sourceDir,
      inPath: false,
      isPortable: isPortableBuild(ctx),
      error: 'CLI bundle not built (run npm run build first)'
    }
  }

  const candidateDirs = ctx.platform === 'darwin'
    ? ['/usr/local/bin', path.join(ctx.homeDir, '.local', 'bin')]
    : [path.join(ctx.homeDir, '.local', 'bin')]
  const isExecutable = ctx.isPosixExecutable ?? defaultIsPosixExecutable

  let targetDir = resolvePosixTargetDir(ctx)
  for (const dir of candidateDirs) {
    const primary = inspectPosixCommand(path.join(dir, 'agent-desktop'), isExecutable)
    const alias = inspectPosixCommand(path.join(dir, 'agd'), isExecutable)
    if (primary.managed || alias.managed) {
      targetDir = dir
      const inPath = isDirInEnvPath(dir, ctx.env, ctx.platform)
      const pathSnippet = inPath ? undefined : `export PATH="${dir}:$PATH"`
      if (primary.exists && primary.valid && alias.exists && alias.valid) {
        // Also check whether AppImage path moved
        const expectedAppImage = ctx.env.APPIMAGE
        const staleAppImage = expectedAppImage && primary.target && path.resolve(primary.target) !== path.resolve(expectedAppImage)
        return {
          commands,
          supported: true,
          state: staleAppImage ? 'stale' : 'installed',
          targetPath: dir,
          sourcePath: expectedAppImage || sourceDir,
          inPath,
          isPortable: isPortableBuild(ctx),
          pathSnippet
        }
      }
      return {
        commands,
        supported: true,
        state: 'stale',
        targetPath: dir,
        sourcePath: ctx.env.APPIMAGE || sourceDir,
        inPath,
        isPortable: isPortableBuild(ctx),
        pathSnippet
      }
    }
  }

  const inPath = isDirInEnvPath(targetDir, ctx.env, ctx.platform)
  return {
    commands,
    supported: true,
    state: 'not-installed',
    targetPath: targetDir,
    sourcePath: ctx.env.APPIMAGE || sourceDir,
    inPath,
    isPortable: isPortableBuild(ctx),
    pathSnippet: inPath ? undefined : `export PATH="${targetDir}:$PATH"`
  }
}

export function installAppCliToPath(dataDir: string, override?: Partial<PathInstallerEnv>): AppCliPathStatus {
  const ctx: PathInstallerEnv = { ...defaultEnv(dataDir), ...override }
  const cliEntry = resolveCliEntry(ctx)
  if (!fs.existsSync(cliEntry)) {
    throw new Error(`CLI entrypoint not found at ${cliEntry}`)
  }

  if (ctx.platform === 'win32') {
    const sourceDir = ctx.isPackaged ? path.join(ctx.resourcesPath, 'bin') : ensureDevWindowsShims(ctx)
    if (!fs.existsSync(path.join(sourceDir, 'agent-desktop.cmd'))) {
      throw new Error(`CLI wrapper not found in ${sourceDir}`)
    }
    const readPath = ctx.readWinUserPath ?? readWindowsUserPath
    const writePath = ctx.writeWinUserPath ?? writeWindowsUserPath
    const entries = splitPathEntries(readPath(), ';').filter((e) => !isWindowsAgentDesktopBinEntry(e))
    const targetNorm = normalizeWinDir(sourceDir)
    if (!entries.some((e) => normalizeWinDir(e) === targetNorm)) {
      entries.push(sourceDir)
    }
    writePath(entries.join(';'))
    return getAppCliPathStatus(dataDir, ctx)
  }

  // macOS & Linux
  const targetDir = resolvePosixTargetDir(ctx)
  fs.mkdirSync(targetDir, { recursive: true })
  const isExecutable = ctx.isPosixExecutable ?? defaultIsPosixExecutable
  const chmodPosix = ctx.chmodPosix ?? ((p: string, mode: number) => fs.chmodSync(p, mode))
  const writeManagedScript = (dest: string, lines: string[]): void => {
    fs.writeFileSync(dest, lines.join('\n'), { mode: 0o755 })
    try {
      chmodPosix(dest, 0o755)
    } catch {
      // ignore if filesystem does not support chmod
    }
  }

  for (const name of APP_CLI_COMMANDS) {
    const dest = path.join(targetDir, name)
    const existing = inspectPosixCommand(dest, isExecutable)
    if (existing.exists && !existing.managed) {
      throw new Error(`Refusing to overwrite non-Agent-Desktop file at ${dest}`)
    }
    try {
      fs.rmSync(dest, { force: true })
    } catch {
      // ignore
    }

    if (ctx.env.APPIMAGE) {
      writeManagedScript(dest, [
        '#!/usr/bin/env bash',
        MANAGED_MARKER,
        `AGENT_DESKTOP_CLI=1 exec ${shellQuote(ctx.env.APPIMAGE)} "$@"`,
        ''
      ])
    } else if (ctx.isPackaged) {
      const source = path.join(ctx.resourcesPath, 'bin', name)
      let symlinked = false
      if (fs.existsSync(source)) {
        try {
          chmodPosix(source, 0o755)
        } catch {
          // ignore if read-only bundle
        }
        if (isExecutable(source)) {
          fs.symlinkSync(source, dest)
          symlinked = true
        }
      }
      if (!symlinked) {
        writeManagedScript(dest, [
          '#!/usr/bin/env bash',
          MANAGED_MARKER,
          `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(ctx.execPath)} ${shellQuote(cliEntry)} "$@"`,
          ''
        ])
      }
    } else {
      writeManagedScript(dest, [
        '#!/usr/bin/env bash',
        MANAGED_MARKER,
        `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(ctx.execPath)} ${shellQuote(cliEntry)} "$@"`,
        ''
      ])
    }
  }

  return getAppCliPathStatus(dataDir, ctx)
}

export function uninstallAppCliFromPath(dataDir: string, override?: Partial<PathInstallerEnv>): AppCliPathStatus {
  const ctx: PathInstallerEnv = { ...defaultEnv(dataDir), ...override }

  if (ctx.platform === 'win32') {
    const readPath = ctx.readWinUserPath ?? readWindowsUserPath
    const writePath = ctx.writeWinUserPath ?? writeWindowsUserPath
    const sourceDir = ctx.isPackaged ? path.join(ctx.resourcesPath, 'bin') : path.join(ctx.dataDir, 'bin')
    const targetNorm = normalizeWinDir(sourceDir)
    const entries = splitPathEntries(readPath(), ';').filter(
      (e) => normalizeWinDir(e) !== targetNorm && !isWindowsAgentDesktopBinEntry(e)
    )
    writePath(entries.join(';'))
    return getAppCliPathStatus(dataDir, ctx)
  }

  const candidateDirs = ctx.platform === 'darwin'
    ? ['/usr/local/bin', path.join(ctx.homeDir, '.local', 'bin')]
    : [path.join(ctx.homeDir, '.local', 'bin')]
  const isExecutable = ctx.isPosixExecutable ?? defaultIsPosixExecutable

  for (const dir of candidateDirs) {
    for (const name of APP_CLI_COMMANDS) {
      const dest = path.join(dir, name)
      const info = inspectPosixCommand(dest, isExecutable)
      if (info.exists && info.managed) {
        try {
          fs.rmSync(dest, { force: true })
        } catch {
          // ignore
        }
      }
    }
  }

  return getAppCliPathStatus(dataDir, ctx)
}
