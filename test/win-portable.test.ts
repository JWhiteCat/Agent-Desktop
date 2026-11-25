import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { writeBuildStamp, writeDependencyStamp } from '../scripts/win-launcher-state.mjs'

const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
const fixtures: string[] = []

function makePortableProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-win-portable-'))
  fixtures.push(dir)
  fs.mkdirSync(path.join(dir, 'src/main'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src/renderer/src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules/electron/dist'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules/mermaid'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'out/main'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'out/preload'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'out/renderer/vendor/mermaid'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'release'), { recursive: true })

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'agent-desktop',
    devDependencies: { electron: '^44.5.0', mermaid: '^12.2.0' }
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
  fs.writeFileSync(path.join(dir, 'out/main/cli.cjs'), '')
  fs.writeFileSync(path.join(dir, 'out/preload/index.js'), '')
  fs.writeFileSync(path.join(dir, 'out/renderer/index.html'), '')
  fs.writeFileSync(path.join(dir, 'out/renderer/vendor/mermaid/mermaid.esm.min.mjs'), '')
  fs.writeFileSync(path.join(dir, 'release/agent-desktop-0.1.0-win-x64-portable.exe'), '')

  fs.copyFileSync(path.resolve('scripts/win-launcher-state.mjs'), path.join(dir, 'scripts/win-launcher-state.mjs'))
  fs.copyFileSync(path.resolve('build-portable.bat'), path.join(dir, 'build-portable.bat'))

  writeDependencyStamp(dir)
  writeBuildStamp(dir)
  return dir
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('Windows portable packaging', () => {
  it('builds an x64 portable executable without publishing, native rebuild, or renderer node_modules bloat', () => {
    expect(pkg.build.npmRebuild).toBe(false)
    expect(pkg.build.win.target).toBe('nsis')
    expect(pkg.build.win.electronLanguages).toEqual(['en-US', 'en-GB', 'zh-CN', 'zh-TW'])
    expect(pkg.build.portable).toEqual({
      artifactName: '${name}-${version}-win-${arch}-portable.${ext}',
      requestExecutionLevel: 'user'
    })
    expect(pkg.build.files).toEqual(expect.arrayContaining([
      '!node_modules/js-tiktoken/dist/index.*',
      '!node_modules/js-tiktoken/dist/ranks/{gpt2,o200k_base,p50k_base,p50k_edit,r50k_base}.*'
    ]))
    // Renderer-only and main-bundled libraries belong in devDependencies so electron-builder does not pack them into app.asar.
    for (const bundled of ['mermaid', 'react', 'react-dom', 'react-markdown', 'remark-gfm', 'micromark-core-commonmark', 'qrcode', 'cross-spawn']) {
      expect(pkg.dependencies).not.toHaveProperty(bundled)
      expect(pkg.devDependencies).toHaveProperty(bundled)
    }
    expect(pkg.scripts['dist:win:portable']).toBe('electron-vite build && electron-builder --win portable --x64 --publish never')
    const bat = fs.readFileSync(path.resolve('build-portable.bat'), 'utf8')
    expect(bat).toContain('scripts\\win-launcher-state.mjs')
    expect(bat).toContain('set "CSC_IDENTITY_AUTO_DISCOVERY=false"')
    expect(bat).toContain('--win portable --x64 --publish never --config.electronDist=node_modules/electron/dist')
    expect(bat).toContain('release\\*-win-*-portable.exe')
  })
})

describe.skipIf(process.platform !== 'win32')('Windows build-portable.bat integration', () => {
  it('skips npm install and build when cached, defaults fast compression, and honors --rebuild, --max, and custom compression level', () => {
    const dir = makePortableProject()
    const logFile = path.join(dir, 'calls.log')
    const fakeBin = path.join(dir, 'node_modules/.bin')
    fs.writeFileSync(path.join(fakeBin, 'electron-vite.cmd'), `@echo off\r\necho electron-vite %*>>"${logFile}"\r\nexit /b 0\r\n`)
    fs.writeFileSync(
      path.join(fakeBin, 'electron-builder.cmd'),
      `@echo off\r\necho electron-builder %* LEVEL=%ELECTRON_BUILDER_COMPRESSION_LEVEL% CSC=%CSC_IDENTITY_AUTO_DISCOVERY% NODE_ENV=%NODE_ENV% AS_NODE=%ELECTRON_RUN_AS_NODE%>>"${logFile}"\r\nexit /b 0\r\n`
    )

    const baseEnv: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    delete baseEnv.ELECTRON_BUILDER_COMPRESSION_LEVEL

    const fast = spawnSync('cmd.exe', ['/d', '/c', path.join(dir, 'build-portable.bat')], { cwd: os.tmpdir(), env: baseEnv, encoding: 'utf8' })
    expect(fast.status, fast.stdout + fast.stderr).toBe(0)
    expect(fast.stdout).toContain('skipping npm install')
    expect(fast.stdout).toContain('skipping build')
    expect(fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/)).toEqual([
      'electron-builder --win portable --x64 --publish never --config.electronDist=node_modules/electron/dist LEVEL=1 CSC=false NODE_ENV=production AS_NODE='
    ])

    fs.rmSync(logFile)
    const rebuildMax = spawnSync('cmd.exe', ['/d', '/c', path.join(dir, 'build-portable.bat'), '--rebuild', '--max'], { cwd: os.tmpdir(), env: baseEnv, encoding: 'utf8' })
    expect(rebuildMax.status, rebuildMax.stdout + rebuildMax.stderr).toBe(0)
    expect(fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/)).toEqual([
      'electron-vite build',
      'electron-builder --win portable --x64 --publish never --config.electronDist=node_modules/electron/dist LEVEL=9 CSC=false NODE_ENV=production AS_NODE='
    ])

    fs.rmSync(logFile)
    const customLevel = spawnSync('cmd.exe', ['/d', '/c', path.join(dir, 'build-portable.bat')], {
      cwd: os.tmpdir(),
      env: { ...baseEnv, ELECTRON_BUILDER_COMPRESSION_LEVEL: '3' },
      encoding: 'utf8'
    })
    expect(customLevel.status, customLevel.stdout + customLevel.stderr).toBe(0)
    expect(fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/)).toEqual([
      'electron-builder --win portable --x64 --publish never --config.electronDist=node_modules/electron/dist LEVEL=3 CSC=false NODE_ENV=production AS_NODE='
    ])

    const help = spawnSync('cmd.exe', ['/d', '/c', path.join(dir, 'build-portable.bat'), '--help'], { cwd: os.tmpdir(), env: baseEnv, encoding: 'utf8' })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('--install')
    expect(help.stdout).toContain('--rebuild')
    expect(help.stdout).toContain('--max')
  })
})
