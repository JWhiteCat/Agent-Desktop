import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareReleaseArtifacts } from '../scripts/release-artifacts.mjs'

const roots: string[] = []
const names = [
  'agent-desktop-1.0.0-win-x64-portable.exe',
  'agent-desktop-1.0.0-win-x64-setup.exe',
  'agent-desktop-1.0.0-linux-x86_64.AppImage',
  'agent-desktop-1.0.0-linux-amd64.deb'
]

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-artifacts-'))
  roots.push(directory)
  for (const name of names) fs.writeFileSync(path.join(directory, name), `installer ${name}`)
  return directory
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('release artifacts', () => {
  it('includes four installers and a checksum manifest that matches their contents', () => {
    const directory = fixture()
    fs.writeFileSync(path.join(directory, 'builder-debug.yml'), 'not a release asset')
    const files = prepareReleaseArtifacts(directory, '1.0.0')
    expect(files.map((file: string) => path.basename(file)).sort()).toEqual([...names, 'SHA256SUMS.txt'].sort())
    const manifest = fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8')
    for (const name of names) {
      const hash = createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')
      expect(manifest).toContain(`${hash}  ${name}\n`)
    }
  })

  it('refuses incomplete, empty, ambiguous, or wrong-version installers', () => {
    const directory = fixture()
    const portable = path.join(directory, names[0])
    fs.unlinkSync(portable)
    expect(() => prepareReleaseArtifacts(directory, '1.0.0')).toThrow(/Windows portable/)
    expect(fs.existsSync(path.join(directory, 'SHA256SUMS.txt'))).toBe(false)
    fs.writeFileSync(portable, '')
    expect(() => prepareReleaseArtifacts(directory, '1.0.0')).toThrow(/Empty release artifact/)
    fs.writeFileSync(portable, 'portable')
    fs.writeFileSync(path.join(directory, 'agent-desktop-1.0.0-linux-x64.AppImage'), 'duplicate')
    expect(() => prepareReleaseArtifacts(directory, '1.0.0')).toThrow(/Linux AppImage/)
    expect(() => prepareReleaseArtifacts(directory, '1.0.1')).toThrow(/Windows portable/)
  })
})
