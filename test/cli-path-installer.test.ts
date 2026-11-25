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
})
