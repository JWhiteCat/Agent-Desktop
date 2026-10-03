import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { LinuxTargetHelper } = require('app-builder-lib/out/targets/LinuxTargetHelper')
const { default: AppImageTarget } = require('app-builder-lib/out/targets/appimage/AppImageTarget')
const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))

function packager() {
  return {
    appInfo: { productName: pkg.productName, sanitizedProductName: pkg.productName, buildVersion: pkg.version, description: pkg.description },
    info: { metadata: pkg },
    config: pkg.build,
    platformSpecificBuildOptions: pkg.build.linux,
    executableName: pkg.build.linux.executableName,
    fileAssociations: []
  }
}

describe('Linux packaging', () => {
  it('has explicit x64 targets and non-publishing build commands', () => {
    expect(pkg.build.linux.target).toEqual([{ target: 'AppImage', arch: ['x64'] }, { target: 'deb', arch: ['x64'] }])
    expect(pkg.scripts['dist:linux']).toContain('--linux --x64 --publish never')
    expect(pkg.scripts['dist:linux:dir']).toContain('--linux --x64 --dir --publish never')
    expect(pkg.homepage).toMatch(/^https:\/\//)
    expect(pkg.build.linux.maintainer).toMatch(/.+ <.+@.+>/)
  })

  it('ships valid PNG icons at each desktop size and the runtime icon in app.asar', () => {
    expect(pkg.build.files).toContain('resources/icons/**/*')
    for (const size of [16, 24, 32, 48, 64, 96, 128, 256, 512]) {
      const png = fs.readFileSync(path.resolve(pkg.build.linux.icon, `${size}x${size}.png`))
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(png.readUInt32BE(16)).toBe(size)
      expect(png.readUInt32BE(20)).toBe(size)
    }
  })

  it('generates a launcher with matching desktop identity, category and icon', async () => {
    const helper = new LinuxTargetHelper(packager())
    expect(helper.getDesktopFileName()).toBe('dev.agentdesktop.app')
    const desktop = await helper.computeDesktopEntry(pkg.build.linux)
    expect(desktop).toContain('StartupWMClass=dev.agentdesktop.app\n')
    expect(desktop).toContain('Icon=agent-desktop\n')
    expect(desktop).toContain('Categories=Development;\n')
    expect(desktop).toContain('Exec="/opt/Agent Desktop/agent-desktop" %U\n')
    expect(desktop).not.toContain('--no-sandbox')
  })

  it('overrides electron-builder AppImage sandbox-disabling defaults', async () => {
    const config = packager()
    const target = new AppImageTarget('AppImage', config, new LinuxTargetHelper(config), 'release')
    const desktop = await target.desktopEntry.value
    expect(desktop).toContain('Exec=AppRun %U\n')
    expect(desktop).not.toContain('--no-sandbox')
  })

  it.runIf(process.platform === 'linux')('ships an AppRun that preserves the sandbox and arguments from paths with spaces', () => {
    expect(pkg.build.linux.extraFiles).toContainEqual({ from: 'scripts/linux-appimage-apprun.sh', to: 'AppRun' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent appimage '))
    try {
      const launcher = path.join(dir, 'AppRun')
      fs.copyFileSync(path.resolve('scripts/linux-appimage-apprun.sh'), launcher)
      fs.writeFileSync(path.join(dir, 'agent-desktop'), `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), electronNode: process.env.ELECTRON_RUN_AS_NODE, libraries: process.env.LD_LIBRARY_PATH, data: process.env.XDG_DATA_DIRS }))`, { mode: 0o755 })
      // A restricted machine must not turn a failed namespace probe into --no-sandbox.
      fs.writeFileSync(path.join(dir, 'unshare'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 })
      for (const appDir of ['', dir]) {
        const result = spawnSync('bash', [launcher, 'a path with spaces', '--test-flag'], {
          cwd: os.tmpdir(), encoding: 'utf8',
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, APPDIR: appDir, ELECTRON_RUN_AS_NODE: '1', LD_LIBRARY_PATH: '/existing/lib', XDG_DATA_DIRS: '/existing/share' }
        })
        expect(result.status).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({
          args: ['a path with spaces', '--test-flag'],
          libraries: `${dir}/usr/lib:/existing/lib`,
          data: `${dir}/usr/share:/existing/share`
        })
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
