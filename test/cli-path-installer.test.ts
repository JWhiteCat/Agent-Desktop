import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getAppCliPathStatus,
  installAppCliToPath,
  uninstallAppCliFromPath,
  type PathInstallerEnv
} from '../src/main/cli-path-installer'

describe('cli-path-installer', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-path-inst-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('installs, inspects, detects stale entries, and uninstalls on Windows (user PATH)', () => {
    const resourcesPath = path.join(tmpRoot, 'app', 'resources')
    const binDir = path.join(resourcesPath, 'bin')
    const cliDir = path.join(resourcesPath, 'cli')
    const dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(binDir, { recursive: true })
    fs.mkdirSync(cliDir, { recursive: true })
    fs.writeFileSync(path.join(cliDir, 'cli.cjs'), '// cli')
    fs.writeFileSync(path.join(binDir, 'agent-desktop.cmd'), '@echo off\r\n')
    fs.writeFileSync(path.join(binDir, 'agd.cmd'), '@echo off\r\n')

    let userPath = 'C:\\Windows\\System32'
    const baseCtx: Partial<PathInstallerEnv> = {
      platform: 'win32',
      isPackaged: true,
      resourcesPath,
      dataDir,
      execPath: path.join(tmpRoot, 'app', 'Agent Desktop.exe'),
      appPath: path.join(tmpRoot, 'app'),
      homeDir: tmpRoot,
      env: {},
      readWinUserPath: () => userPath,
      writeWinUserPath: (next) => { userPath = next }
    }

    expect(getAppCliPathStatus(dataDir, baseCtx).state).toBe('not-installed')

    const installed = installAppCliToPath(dataDir, baseCtx)
    expect(installed.state).toBe('installed')
    expect(installed.commands).toEqual(['agent-desktop', 'agd'])
    expect(userPath).toContain(binDir)

    // Simulate moved portable directory -> stale state
    const movedResources = path.join(tmpRoot, 'moved-app', 'resources')
    const movedBin = path.join(movedResources, 'bin')
    const movedCli = path.join(movedResources, 'cli')
    fs.mkdirSync(movedBin, { recursive: true })
    fs.mkdirSync(movedCli, { recursive: true })
    fs.writeFileSync(path.join(movedCli, 'cli.cjs'), '// cli')
    fs.writeFileSync(path.join(movedBin, 'agent-desktop.cmd'), '@echo off\r\n')
    fs.writeFileSync(path.join(movedBin, 'agd.cmd'), '@echo off\r\n')
    expect(getAppCliPathStatus(dataDir, { ...baseCtx, resourcesPath: movedResources }).state).toBe('stale')

    const reinstalled = installAppCliToPath(dataDir, { ...baseCtx, resourcesPath: movedResources })
    expect(reinstalled.state).toBe('installed')
    expect(userPath).not.toContain(binDir)
    expect(userPath).toContain(movedBin)

    const removed = uninstallAppCliFromPath(dataDir, { ...baseCtx, resourcesPath: movedResources })
    expect(removed.state).toBe('not-installed')
    expect(userPath).toBe('C:\\Windows\\System32')
  })

  it('installs and uninstalls Linux AppImage managed scripts for agent-desktop and agd', () => {
    const homeDir = path.join(tmpRoot, 'home')
    const resourcesPath = path.join(tmpRoot, 'mount', 'resources')
    const cliDir = path.join(resourcesPath, 'cli')
    const dataDir = path.join(tmpRoot, 'data')
    const appImagePath = path.join(tmpRoot, 'Agent-Desktop-0.1.0.AppImage')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(cliDir, { recursive: true })
    fs.writeFileSync(path.join(cliDir, 'cli.cjs'), '// cli')
    fs.writeFileSync(appImagePath, '#!/bin/sh\n')

    const ctx: Partial<PathInstallerEnv> = {
      platform: 'linux',
      isPackaged: true,
      homeDir,
      resourcesPath,
      dataDir,
      execPath: path.join(tmpRoot, 'mount', 'agent-desktop'),
      appPath: path.join(tmpRoot, 'mount'),
      env: { APPIMAGE: appImagePath, PATH: '/usr/bin:/bin' }
    }

    expect(getAppCliPathStatus(dataDir, ctx).state).toBe('not-installed')

    const installed = installAppCliToPath(dataDir, ctx)
    expect(installed.state).toBe('installed')
    expect(installed.inPath).toBe(false)
    expect(installed.pathSnippet).toContain(path.join(homeDir, '.local', 'bin'))
    expect(installed.isPortable).toBe(true)

    const primaryFile = path.join(homeDir, '.local', 'bin', 'agent-desktop')
    const aliasFile = path.join(homeDir, '.local', 'bin', 'agd')
    expect(fs.readFileSync(primaryFile, 'utf8')).toContain('AGENT_DESKTOP_CLI=1')
    expect(fs.readFileSync(aliasFile, 'utf8')).toContain('AGENT_DESKTOP_CLI=1')

    // Moving the AppImage marks the installation stale.
    const stale = getAppCliPathStatus(dataDir, { ...ctx, env: { APPIMAGE: path.join(tmpRoot, 'New.AppImage'), PATH: '/usr/bin' } })
    expect(stale.state).toBe('stale')

    const removed = uninstallAppCliFromPath(dataDir, ctx)
    expect(removed.state).toBe('not-installed')
    expect(fs.existsSync(primaryFile)).toBe(false)
    expect(fs.existsSync(aliasFile)).toBe(false)
  })

  it('keeps packaged POSIX CLI wrapper scripts executable in git and on POSIX filesystems', () => {
    const scripts = ['resources/cli-bin/agent-desktop', 'resources/cli-bin/agd']
    if (fs.existsSync(path.resolve('.git'))) {
      const out = execFileSync('git', ['ls-files', '-s', ...scripts], { encoding: 'utf8', windowsHide: true })
      const lines = out.trim().split(/\r?\n/)
      expect(lines).toHaveLength(2)
      for (const line of lines) {
        expect(line).toMatch(/^100755\s+/)
      }
    }
    if (process.platform !== 'win32') {
      for (const rel of scripts) {
        expect(fs.statSync(path.resolve(rel)).mode & 0o111).not.toBe(0)
      }
    }
  })

  it('writes executable managed shims instead of non-executable symlinks for read-only POSIX bundles', () => {
    const homeDir = path.join(tmpRoot, 'home')
    const appDir = path.join(tmpRoot, 'opt', 'Agent Desktop')
    const resourcesPath = path.join(appDir, 'resources')
    const binDir = path.join(resourcesPath, 'bin')
    const cliDir = path.join(resourcesPath, 'cli')
    const execPath = path.join(appDir, 'agent-desktop')
    const dataDir = path.join(tmpRoot, 'data')
    fs.mkdirSync(homeDir, { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })
    fs.mkdirSync(cliDir, { recursive: true })
    fs.writeFileSync(execPath, '#!/bin/sh\n')
    fs.writeFileSync(path.join(cliDir, 'cli.cjs'), '// cli')
    fs.writeFileSync(path.join(binDir, 'agent-desktop'), '#!/usr/bin/env bash\n', { mode: 0o644 })
    fs.writeFileSync(path.join(binDir, 'agd'), '#!/usr/bin/env bash\n', { mode: 0o644 })

    const readOnlySource = new Set([path.join(binDir, 'agent-desktop'), path.join(binDir, 'agd')])
    const ctx: Partial<PathInstallerEnv> = {
      platform: 'linux',
      isPackaged: true,
      homeDir,
      resourcesPath,
      dataDir,
      execPath,
      appPath: appDir,
      env: { PATH: `${path.join(homeDir, '.local', 'bin')}:/usr/bin` },
      chmodPosix: (filePath, mode) => {
        if (readOnlySource.has(filePath)) {
          const err = new Error(`EPERM: operation not permitted, chmod '${filePath}'`) as NodeJS.ErrnoException
          err.code = 'EPERM'
          throw err
        }
        fs.chmodSync(filePath, mode)
      },
      isPosixExecutable: (filePath) => !readOnlySource.has(filePath)
    }

    const installed = installAppCliToPath(dataDir, ctx)
    expect(installed.state).toBe('installed')
    expect(installed.inPath).toBe(true)

    for (const cmd of ['agent-desktop', 'agd']) {
      const dest = path.join(homeDir, '.local', 'bin', cmd)
      expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false)
      const content = fs.readFileSync(dest, 'utf8')
      expect(content).toContain('# Managed by Agent Desktop CLI')
      expect(content).toContain(`ELECTRON_RUN_AS_NODE=1 exec '${execPath}' '${path.join(cliDir, 'cli.cjs')}' "$@"`)
    }

    // Non-executable installed commands are reported as stale rather than installed.
    expect(getAppCliPathStatus(dataDir, { ...ctx, isPosixExecutable: () => false }).state).toBe('stale')

    const removed = uninstallAppCliFromPath(dataDir, ctx)
    expect(removed.state).toBe('not-installed')
  })
})
