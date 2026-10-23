import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/

function assertVersion(version) {
  if (!VERSION.test(version)) throw new Error(`Version must be MAJOR.MINOR.PATCH: ${version}`)
}

function normalize(markdown) {
  return markdown.replace(/\r\n/g, '\n')
}

function versionHeading(version) {
  return new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\](?: - \\d{4}-\\d{2}-\\d{2})?[ \\t]*$`, 'm')
}

export function promoteUnreleased(markdown, version, date) {
  assertVersion(version)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid release date: ${date}`)
  const text = normalize(markdown)
  if (versionHeading(version).test(text)) throw new Error(`CHANGELOG.md already contains ${version}`)
  const unreleased = /^## \[Unreleased\][ \t]*$/m.exec(text)
  if (!unreleased) throw new Error('CHANGELOG.md needs a "## [Unreleased]" section')
  const rest = text.slice(unreleased.index + unreleased[0].length)
  const next = rest.search(/\n## \[/)
  const body = (next === -1 ? rest : rest.slice(0, next)).replace(/^\n+/, '').replace(/\s+$/, '')
  if (!body) throw new Error('Write the release notes under "## [Unreleased]" before publishing')
  const after = next === -1 ? '\n' : rest.slice(next)
  const changelog = `${text.slice(0, unreleased.index)}## [Unreleased]\n\n## [${version}] - ${date}\n\n${body}\n${after}`
  return changelog.endsWith('\n') ? changelog : `${changelog}\n`
}

export function releaseNotes(markdown, version) {
  assertVersion(version)
  const text = normalize(markdown)
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}[ \\t]*$`, 'm').exec(text)
  if (!heading) throw new Error(`CHANGELOG.md has no dated section for ${version}`)
  const rest = text.slice(heading.index + heading[0].length)
  const next = rest.search(/\n## \[/)
  const body = (next === -1 ? rest : rest.slice(0, next)).replace(/^\n+/, '').replace(/\s+$/, '')
  if (!body) throw new Error(`Changelog section ${version} is empty`)
  return `${heading[0]}\n\n${body}\n`
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
const self = fileURLToPath(import.meta.url)
const direct = process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self
if (direct) {
  const version = process.argv[2]
  if (!version || process.argv.length !== 3) {
    console.error('Usage: node scripts/changelog.mjs X.Y.Z')
    process.exit(1)
  }
  try {
    process.stdout.write(releaseNotes(fs.readFileSync(path.resolve('CHANGELOG.md'), 'utf8'), version))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
