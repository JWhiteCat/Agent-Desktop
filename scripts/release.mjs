import spawn from 'cross-spawn'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertVersion, promoteUnreleased, releaseNotes } from './changelog.mjs'

function localDate(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function run(cwd, command, args, log) {
  log(`> ${command} ${args.join(' ')}`)
  const result = spawn.sync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  if (result.error) throw new Error(`${command} ${args.join(' ')} failed: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim()
    throw new Error(detail || `${command} ${args.join(' ')} failed`)
  }
  return result.stdout ?? ''
}

export function assertOnlyChangelog(status) {
  const lines = status.split(/\r?\n/).filter(Boolean)
  const extra = lines.filter((line) => !/^.. CHANGELOG\.md$/.test(line))
  if (extra.length > 0) {
    throw new Error(`Commit or stash other changes before releasing:\n${lines.join('\n')}`)
  }
}

function refExists(cwd, ref) {
  const result = spawn.sync('git', ['show-ref', '--verify', '--quiet', ref], {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.error) throw new Error(result.error.message)
  return result.status === 0
}

export function publishRelease(version, options = {}) {
  assertVersion(version)
  const cwd = options.cwd ?? process.cwd()
  const date = options.date ?? localDate()
  const log = options.log ?? console.log
  const git = (args) => run(cwd, 'git', args, log)

  assertOnlyChangelog(git(['status', '--porcelain=v1', '-uall']))
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  if (branch !== 'master') throw new Error('Publish from master. This script creates the release branch.')

  git(['fetch', 'origin'])
  git(['rev-parse', '--verify', 'origin/master'])
  const ancestor = spawn.sync('git', ['merge-base', '--is-ancestor', 'origin/master', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  })
  if (ancestor.error) throw new Error(ancestor.error.message)
  if (ancestor.status !== 0) {
    throw new Error('master is behind or diverged from origin/master. Integrate the remote branch before releasing.')
  }
  if (refExists(cwd, `refs/heads/release/${version}`)) throw new Error(`Branch release/${version} already exists`)
  if (refExists(cwd, `refs/tags/v${version}`)) throw new Error(`Tag v${version} already exists`)
  if (git(['ls-remote', '--heads', 'origin', `refs/heads/release/${version}`]).trim()) {
    throw new Error(`origin already has release/${version}`)
  }
  if (git(['ls-remote', '--tags', 'origin', `refs/tags/v${version}`]).trim()) {
    throw new Error(`origin already has v${version}`)
  }

  const changelogPath = path.join(cwd, 'CHANGELOG.md')
  if (!fs.existsSync(changelogPath)) throw new Error('CHANGELOG.md is missing')
  const updated = promoteUnreleased(fs.readFileSync(changelogPath, 'utf8'), version, date)
  releaseNotes(updated, version)
  fs.writeFileSync(changelogPath, updated)

  let onReleaseBranch = false
  try {
    git(['add', '--', 'CHANGELOG.md'])
    git(['commit', '-m', `Document changes in ${version}.`])
    git(['switch', '-c', `release/${version}`])
    onReleaseBranch = true
    run(cwd, 'npm', ['version', version, '--no-git-tag-version'], log)
    git(['add', '--', 'package.json', 'package-lock.json'])
    git(['commit', '-m', `Release ${version}.`])
    git(['push', 'origin', 'master'])
    git(['push', '-u', 'origin', `release/${version}`])
    git(['tag', '-a', `v${version}`, '-m', version])
    git(['push', 'origin', `v${version}`])
  } finally {
    if (onReleaseBranch) spawn.sync('git', ['switch', 'master'], { cwd, windowsHide: true })
  }
  log(`Pushed release/${version} and v${version}. GitHub Actions will publish the changelog and installers.`)
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
const self = fileURLToPath(import.meta.url)
const direct = process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self
if (direct) {
  const version = process.argv[2]
  if (!version || process.argv.length !== 3) {
    console.error('Usage: npm run release -- X.Y.Z')
    process.exit(1)
  }
  try {
    publishRelease(version)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
