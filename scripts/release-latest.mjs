import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertVersion, VERSION } from './changelog.mjs'

/** Called inside the repository-wide publish job lock, immediately before publication. */
export function shouldMakeLatest(version, pages) {
  assertVersion(version)
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error('Expected paginated GitHub release arrays')
  }
  const candidate = version.split('.').map(BigInt)
  for (const release of pages.flat()) {
    if (!release || typeof release.tag_name !== 'string' ||
        typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') {
      throw new Error('Invalid GitHub release metadata')
    }
    if (release.draft || release.prerelease) continue
    const tag = release.tag_name
    // Only this project's stable vMAJOR.MINOR.PATCH releases participate.
    if (!tag.startsWith('v') || !VERSION.test(tag.slice(1))) continue
    const existing = tag.slice(1).split('.').map(BigInt)
    for (let index = 0; index < 3; index++) {
      if (existing[index] > candidate[index]) return false
      if (existing[index] < candidate[index]) break
    }
  }
  return true
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
const self = fileURLToPath(import.meta.url)
const direct = process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self
if (direct) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/release-latest.mjs VERSION RELEASES_JSON')
    console.log(shouldMakeLatest(process.argv[2], JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
