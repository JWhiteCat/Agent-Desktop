import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeBuildFingerprint,
  dependenciesNeedInstall,
  getPreflightState,
  isSupportedNodeVersion,
  previewNeedsBuild,
  resolveElectronBinary,
  writeBuildStamp,
  writeDependencyStamp
} from '../scripts/win-launcher-state.mjs'

const fixtures: string[] = []

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-win-launcher-'))
  fixtures.push(dir)
  fs.mkdirSync(path.join(dir, 'src/main'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src/renderer/src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules/electron/dist'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules/mermaid'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'out/main'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'out/preload'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'out/renderer/vendor/mermaid'), { recursive: true })

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'agent-desktop',
    dependencies: { mermaid: '^12.2.0' },
    devDependencies: { electron: '^44.5.0' }
  }))
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n')
  fs.writeFileSync(path.join(dir, 'electron.vite.config.ts'), 'export default {}\n')
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}\n')
  fs.writeFileSync(path.join(dir, 'tsconfig.node.json'), '{}\n')
  fs.writeFileSync(path.join(dir, 'tsconfig.web.json'), '{}\n')
  fs.writeFileSync(path.join(dir, 'src/main/index.ts'), 'console.log("hi")\n')
  fs.writeFileSync(path.join(dir, 'src/renderer/src/App.tsx'), 'export const App = () => null\n')

  fs.writeFileSync(path.join(dir, 'node_modules/.package-lock.json'), '{"lockfileVersion":3}\n')
  fs.writeFileSync(path.join(dir, 'node_modules/mermaid/package.json'), '{"name":"mermaid","version":"12.2.0"}\n')
  fs.writeFileSync(path.join(dir, 'node_modules/electron/package.json'), '{"name":"electron","version":"44.5.0"}\n')
  fs.writeFileSync(path.join(dir, 'node_modules/electron/path.txt'), 'electron.exe\n')
  fs.writeFileSync(path.join(dir, 'node_modules/electron/dist/version'), 'v44.5.0\n')
  fs.writeFileSync(path.join(dir, 'node_modules/electron/dist/electron.exe'), '')

  fs.writeFileSync(path.join(dir, 'out/main/index.js'), '')
  fs.writeFileSync(path.join(dir, 'out/main/toolbar-runner.cjs'), '')
  fs.writeFileSync(path.join(dir, 'out/preload/index.js'), '')
  fs.writeFileSync(path.join(dir, 'out/renderer/index.html'), '')
  fs.writeFileSync(path.join(dir, 'out/renderer/vendor/mermaid/mermaid.esm.min.mjs'), '')

  return dir
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('Windows launcher state helper', () => {
  it('validates supported Node versions', () => {
    expect(isSupportedNodeVersion('22.12.0')).toBe(true)
    expect(isSupportedNodeVersion('v24.13.6')).toBe(true)
    expect(isSupportedNodeVersion('26.0.0')).toBe(true)
    expect(isSupportedNodeVersion('22.11.9')).toBe(false)
    expect(isSupportedNodeVersion('23.1.0')).toBe(false)
    expect(isSupportedNodeVersion('25.0.0')).toBe(false)
    expect(isSupportedNodeVersion('20.19.0')).toBe(false)
  })

  it('detects when dependencies are up to date, missing, or stale against package-lock.json', () => {
    const dir = makeProject()
    writeDependencyStamp(dir)
    expect(dependenciesNeedInstall(dir)).toBe(false)

    // Removing a direct dependency forces reinstall.
    fs.rmSync(path.join(dir, 'node_modules/mermaid/package.json'))
    expect(dependenciesNeedInstall(dir)).toBe(true)
    fs.writeFileSync(path.join(dir, 'node_modules/mermaid/package.json'), '{"name":"mermaid","version":"12.2.0"}\n')
    expect(dependenciesNeedInstall(dir)).toBe(false)

    // Updating package-lock.json newer than node_modules/.package-lock.json triggers reinstall until stamped.
    const future = new Date(Date.now() + 60_000)
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n')
    fs.utimesSync(path.join(dir, 'package-lock.json'), future, future)
    expect(dependenciesNeedInstall(dir)).toBe(true)

    writeDependencyStamp(dir)
    expect(dependenciesNeedInstall(dir)).toBe(false)
  })

  it('verifies the Electron executable path and version match', () => {
    const dir = makeProject()
    expect(resolveElectronBinary(dir)).toBe(path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe'))

    fs.writeFileSync(path.join(dir, 'node_modules/electron/dist/version'), 'v43.0.0\n')
    expect(resolveElectronBinary(dir)).toBeNull()

    fs.writeFileSync(path.join(dir, 'node_modules/electron/dist/version'), 'v44.5.0\n')
    fs.rmSync(path.join(dir, 'node_modules/electron/dist/electron.exe'))
    expect(resolveElectronBinary(dir)).toBeNull()
  })

  it('tracks preview build staleness across source edits and missing outputs', () => {
    const dir = makeProject()
    expect(previewNeedsBuild(dir)).toBe(true)

    writeBuildStamp(dir)
    expect(previewNeedsBuild(dir)).toBe(false)

    const before = computeBuildFingerprint(dir)
    fs.writeFileSync(path.join(dir, 'src/renderer/src/App.tsx'), 'export const App = () => "updated"\n')
    expect(computeBuildFingerprint(dir)).not.toBe(before)
    expect(previewNeedsBuild(dir)).toBe(true)

    writeBuildStamp(dir)
    expect(previewNeedsBuild(dir)).toBe(false)

    fs.rmSync(path.join(dir, 'out/renderer/vendor/mermaid/mermaid.esm.min.mjs'))
    expect(previewNeedsBuild(dir)).toBe(true)
  })

  it('reports combined preflight state in one call', () => {
    const dir = makeProject()
    writeDependencyStamp(dir)
    writeBuildStamp(dir)
    expect(getPreflightState(dir, 'preview', '24.0.0')).toEqual({
      nodeOk: true,
      needInstall: false,
      electronExe: path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe'),
      needBuild: false
    })
  })
})

describe.skipIf(process.platform !== 'win32')('Windows start-preview.bat integration', () => {
  it('skips npm install and build when cached, and honors --rebuild and --install', () => {
    const dir = makeProject()
    fs.copyFileSync(path.resolve('scripts/win-launcher-state.mjs'), path.join(dir, 'scripts/win-launcher-state.mjs'))
    fs.copyFileSync(path.resolve('start-preview.bat'), path.join(dir, 'start-preview.bat'))

    const logFile = path.join(dir, 'calls.log')
    const fakeBin = path.join(dir, 'node_modules/.bin')
    fs.mkdirSync(fakeBin, { recursive: true })
    fs.writeFileSync(path.join(fakeBin, 'electron-vite.cmd'), `@echo off\r\necho electron-vite %*>>"${logFile}"\r\nexit /b 0\r\n`)
    // Point Electron path.txt to a stub .cmd so launching the preview exits cleanly and logs its invocation.
    fs.writeFileSync(path.join(dir, 'node_modules/electron/path.txt'), 'electron.cmd\n')
    fs.writeFileSync(path.join(dir, 'node_modules/electron/dist/electron.cmd'), `@echo off\r\necho electron %* NODE_ENV=%NODE_ENV% AS_NODE=%ELECTRON_RUN_AS_NODE%>>"${logFile}"\r\nexit /b 0\r\n`)

    writeDependencyStamp(dir)
    writeBuildStamp(dir)

    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    const fast = spawnSync('cmd.exe', ['/d', '/c', path.join(dir, 'start-preview.bat')], { cwd: os.tmpdir(), env, encoding: 'utf8' })
    expect(fast.status, fast.stdout + fast.stderr).toBe(0)
    expect(fast.stdout).toContain('skipping npm install')
    expect(fast.stdout).toContain('skipping build')
    const fastCalls = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/)
    expect(fastCalls).toEqual(['electron . NODE_ENV=production AS_NODE='])

    fs.rmSync(logFile)
    const rebuild = spawnSync('cmd.exe', ['/d', '/c', path.join(dir, 'start-preview.bat'), '--rebuild'], { cwd: os.tmpdir(), env, encoding: 'utf8' })
    expect(rebuild.status, rebuild.stdout + rebuild.stderr).toBe(0)
    const rebuildCalls = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/)
    expect(rebuildCalls).toEqual([
      'electron-vite build',
      'electron . NODE_ENV=production AS_NODE='
    ])

    const help = spawnSync('cmd.exe', ['/d', '/c', path.join(dir, 'start-preview.bat'), '--help'], { cwd: os.tmpdir(), env, encoding: 'utf8' })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('--rebuild')
    expect(help.stdout).toContain('--install')
  })
})
