import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))

describe('Windows portable packaging', () => {
  it('builds an x64 portable executable without publishing or replacing the NSIS target', () => {
    expect(pkg.build.win.target).toBe('nsis')
    expect(pkg.build.portable).toEqual({
      artifactName: '${name}-${version}-win-${arch}-portable.${ext}',
      requestExecutionLevel: 'user'
    })
    expect(pkg.scripts['dist:win:portable']).toBe('electron-vite build && electron-builder --win portable --x64 --publish never')
    const bat = fs.readFileSync(path.resolve('build-portable.bat'), 'utf8')
    expect(bat).toContain('npm.cmd run dist:win:portable')
    expect(bat).toContain('set "CSC_IDENTITY_AUTO_DISCOVERY=false"')
    expect(bat).toContain('release\\*-win-*-portable.exe')
  })
})
