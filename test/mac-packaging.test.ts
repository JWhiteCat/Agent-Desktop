import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))

describe('macOS packaging', () => {
  it('uses account-free ad-hoc signing, automation metadata and distinct artifact names', () => {
    expect(pkg.build.mac).toMatchObject({
      target: 'dmg', identity: '-', hardenedRuntime: false, notarize: false,
      minimumSystemVersion: '13.0', category: 'public.app-category.developer-tools',
      artifactName: '${name}-${version}-mac-${arch}.${ext}'
    })
    expect(pkg.build.mac.extendInfo.NSAppleEventsUsageDescription).toContain('Terminal')
    for (const arch of ['arm64', 'x64']) {
      expect(pkg.scripts[`dist:mac:${arch}`]).toContain(`--mac dmg --${arch} --publish never`)
    }
    expect(pkg.scripts['dist:mac']).toContain('--mac dmg --publish never')
    expect(pkg.scripts['dist:mac:dir']).toContain('--mac --dir --publish never')
  })

  it('ships a valid ICNS container with standard and Retina PNG representations', () => {
    const icon = fs.readFileSync(path.resolve(pkg.build.mac.icon))
    expect(icon.toString('ascii', 0, 4)).toBe('icns')
    expect(icon.readUInt32BE(4)).toBe(icon.length)
    const types: string[] = []
    let offset = 8
    while (offset < icon.length) {
      types.push(icon.toString('ascii', offset, offset + 4))
      const size = icon.readUInt32BE(offset + 4)
      expect(size).toBeGreaterThan(8)
      expect(offset + size).toBeLessThanOrEqual(icon.length)
      expect(icon.subarray(offset + 8, offset + 16).toString('hex')).toBe('89504e470d0a1a0a')
      offset += size
    }
    expect(offset).toBe(icon.length)
    expect(types).toEqual(expect.arrayContaining(['ic07', 'ic08', 'ic09', 'ic10']))
  })
})
