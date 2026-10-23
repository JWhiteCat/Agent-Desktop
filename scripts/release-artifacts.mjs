import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from './changelog.mjs'

/** Require all four installers before creating a public release. */
export function prepareReleaseArtifacts(directory, version) {
  if (!VERSION.test(version)) throw new Error(`Version must be MAJOR.MINOR.PATCH: ${version}`)
  const names = fs.readdirSync(directory).filter((name) => fs.statSync(path.join(directory, name)).isFile())
  const prefix = `agent-desktop-${version}`
  const linuxPrefix = `${prefix}-linux-`
  const groups = [
    names.filter((name) => name === `${prefix}-win-x64-portable.exe`),
    names.filter((name) => name === `${prefix}-win-x64-setup.exe`),
    names.filter((name) => name.startsWith(linuxPrefix) && /^(x64|x86_64)\.AppImage$/.test(name.slice(linuxPrefix.length))),
    names.filter((name) => name.startsWith(linuxPrefix) && /^(x64|amd64)\.deb$/.test(name.slice(linuxPrefix.length)))
  ]
  const labels = ['Windows portable', 'Windows installer', 'Linux AppImage', 'Debian package']
  for (const [index, group] of groups.entries()) {
    if (group.length !== 1) throw new Error(`Expected one ${labels[index]} for ${version}, found ${group.length}`)
  }
  const files = groups.flat().sort()
  const sums = files.map((name) => {
    const file = path.join(directory, name)
    if (fs.statSync(file).size === 0) throw new Error(`Empty release artifact: ${name}`)
    return `${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${name}`
  })
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)
  return [...files, 'SHA256SUMS.txt'].map((name) => path.join(directory, name))
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
const self = fileURLToPath(import.meta.url)
const direct = process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self
if (direct) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/release-artifacts.mjs DIRECTORY X.Y.Z')
    process.stdout.write(`${prepareReleaseArtifacts(process.argv[2], process.argv[3]).join('\n')}\n`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
