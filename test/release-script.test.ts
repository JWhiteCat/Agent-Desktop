import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { releaseNotes } from '../scripts/changelog.mjs'
import { publishRelease } from '../scripts/release.mjs'

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`)
  return result.stdout ?? ''
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('one-step release', () => {
  it('rejects invalid versions before invoking git/npm or touching the checkout or remote', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-release-invalid-'))
    roots.push(root)
    const origin = path.join(root, 'origin.git')
    const work = path.join(root, 'work')
    git(root, ['init', '--bare', '-b', 'master', origin])
    git(root, ['init', '-b', 'master', work])
    git(work, ['config', 'user.email', 'release-test@example.com'])
    git(work, ['config', 'user.name', 'Release Test'])
    git(work, ['config', 'commit.gpgsign', 'false'])
    const originalFiles = {
      'package.json': JSON.stringify({ name: 'agent-desktop', version: '0.1.0' }),
      'package-lock.json': JSON.stringify({ name: 'agent-desktop', version: '0.1.0', lockfileVersion: 3 }),
      'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- Pending changes.\n'
    }
    for (const [name, content] of Object.entries(originalFiles)) fs.writeFileSync(path.join(work, name), content)
    git(work, ['add', '.'])
    git(work, ['commit', '-m', 'Initial commit'])
    git(work, ['remote', 'add', 'origin', origin])
    git(work, ['push', '-u', 'origin', 'master'])
    const localRefs = git(work, ['show-ref'])
    const remoteRefs = git(origin, ['show-ref'])
    for (const version of ['01.2.3', '1.02.3', '1.2.03', 'v1.2.3', '1.2.3-beta.1', '1.2.3+build',
      '1.2.3\n', '9007199254740992.0.0', '0.9007199254740992.0', '0.0.9007199254740992']) {
      const commands: string[] = []
      expect(() => publishRelease(version, { cwd: work, log: (line: string) => commands.push(line) })).toThrow(/MAJOR.MINOR.PATCH/)
      expect(commands).toEqual([])
      expect(git(work, ['show-ref'])).toBe(localRefs)
      expect(git(origin, ['show-ref'])).toBe(remoteRefs)
      expect(git(work, ['status', '--porcelain=v1'])).toBe('')
      for (const [name, content] of Object.entries(originalFiles)) {
        expect(fs.readFileSync(path.join(work, name), 'utf8')).toBe(content)
      }
    }
  })

  it('publishes the changelog from master without leaving the version bump there', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-release-'))
    roots.push(root)
    const origin = path.join(root, 'origin.git')
    const work = path.join(root, 'work')
    git(root, ['init', '--bare', '-b', 'master', origin])
    git(root, ['init', '-b', 'master', work])
    git(work, ['config', 'user.email', 'release-test@example.com'])
    git(work, ['config', 'user.name', 'Release Test'])
    git(work, ['config', 'commit.gpgsign', 'false'])
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({
      name: 'agent-desktop',
      version: '0.1.0'
    }, null, 2) + '\n')
    fs.writeFileSync(path.join(work, 'package-lock.json'), JSON.stringify({
      name: 'agent-desktop',
      version: '0.1.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'agent-desktop', version: '0.1.0' } }
    }, null, 2) + '\n')
    fs.writeFileSync(path.join(work, 'CHANGELOG.md'), `# Changelog

## [Unreleased]

### Added

- Windows portable builds.
`)
    git(work, ['add', '--', 'package.json', 'package-lock.json', 'CHANGELOG.md'])
    git(work, ['commit', '-m', 'Initial commit'])
    git(work, ['remote', 'add', 'origin', origin])
    git(work, ['push', '-u', 'origin', 'master'])

    publishRelease('0.2.0', { cwd: work, date: '2026-10-23', log: () => {} })

    expect(git(work, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('master')
    expect(JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8')).version).toBe('0.1.0')
    const changelog = fs.readFileSync(path.join(work, 'CHANGELOG.md'), 'utf8')
    expect(releaseNotes(changelog, '0.2.0')).toContain('- Windows portable builds.')
    expect(JSON.parse(git(work, ['show', 'release/0.2.0:package.json'])).version).toBe('0.2.0')
    expect(git(work, ['rev-parse', 'v0.2.0^{}']).trim()).toBe(git(work, ['rev-parse', 'release/0.2.0']).trim())
    expect(git(origin, ['rev-parse', 'refs/tags/v0.2.0^{}']).trim()).toBe(git(origin, ['rev-parse', 'refs/heads/release/0.2.0']).trim())
    expect(git(origin, ['show', 'master:CHANGELOG.md'])).toContain('## [0.2.0] - 2026-10-23')
    expect(git(origin, ['show', 'master:package.json'])).toContain('"version": "0.1.0"')
    const publishedHead = git(work, ['rev-parse', 'HEAD']).trim()
    expect(() => publishRelease('0.2.0', { cwd: work, log: () => {} })).toThrow(/already exists/)
    expect(git(work, ['rev-parse', 'HEAD']).trim()).toBe(publishedHead)

    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
    expect(pkg.scripts.release).toBe('node scripts/release.mjs')
    const bat = fs.readFileSync(path.resolve('release.bat'), 'utf8')
    expect(bat).toContain('node scripts\\release.mjs %*')
    expect(bat).toContain('release.bat 0.2.0')
  }, 60000)
})
