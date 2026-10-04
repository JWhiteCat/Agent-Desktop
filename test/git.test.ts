import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitDiff } from '../src/main/git'
import { collectGitFiles } from '../src/renderer/src/lib/diff'
import { untrackedGitPaths } from '../src/shared/git-path'
import { isolateGitEnvironment } from './helpers/git-environment'

describe('Git changes', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-git-'))
    isolateGitEnvironment(root)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    const resolved = path.resolve(root)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-git-')) {
      throw new Error(`Unexpected test directory: ${resolved}`)
    }
    fs.rmSync(resolved, { recursive: true, force: true })
  })

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  }

  function init(format = 'sha1'): void {
    git('init', `--object-format=${format}`)
    git('config', 'core.autocrlf', 'false')
  }

  it.each(['sha1', 'sha256'])('shows the working contents before the first %s commit', async (format) => {
    init(format)
    fs.writeFileSync(path.join(root, 'file.txt'), 'staged version\n')
    git('add', 'file.txt')
    fs.writeFileSync(path.join(root, 'file.txt'), 'working version\n')
    fs.writeFileSync(path.join(root, 'new file.txt'), 'untracked contents\n')

    const result = await gitDiff(root)

    expect(result.isRepo).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.diff).toContain('+working version')
    expect(result.diff).not.toContain('+staged version')
    expect(result.diff).toContain('+untracked contents')
  })

  it('omits a staged file removed from the working tree before the first commit', async () => {
    init()
    const file = path.join(root, 'removed.txt')
    fs.writeFileSync(file, 'already removed\n')
    git('add', 'removed.txt')
    fs.rmSync(file)

    const result = await gitDiff(root)

    expect(result.error).toBeUndefined()
    expect(result.status).toContain('AD removed.txt')
    expect(result.diff).toBe('')
  })

  it.skipIf(process.platform === 'win32').each([
    'quote"file.txt',
    'back\\slash.txt',
    'tab\tfile.txt',
    'line\nbreak.txt',
    'carriage\rreturn.txt',
    ' trailing space.txt ',
    ' leading space.txt',
    '文件-é.txt',
    'dir b/name file.txt'
  ].map((file) => [JSON.stringify(file), file]))('shows untracked contents for %s', async (_label, file) => {
    init()
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), 'untracked special-path contents\n')

    const result = await gitDiff(root)

    expect(result.error).toBeUndefined()
    expect(result.diff).toContain('+untracked special-path contents')
    expect(result.status).toBe(git('-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall'))
    expect(untrackedGitPaths(result.status)).toEqual([file])
    expect(collectGitFiles(result)).toEqual([{
      path: file, lines: ['@@ -0,0 +1,1 @@', '+untracked special-path contents'], added: 1, removed: 0
    }])
    expect(collectGitFiles({ ...result, diff: '' })).toEqual([{ path: file, lines: [], added: 0, removed: 0 }])
    expect(execFileSync('git', ['apply', '--numstat', '-z'], {
      cwd: root, encoding: 'utf8', input: result.diff, windowsHide: true
    })).toBe(`1\t0\t${file}\0`)

    fs.writeFileSync(path.join(root, file), Buffer.from([0, 1, 2]))
    const binary = await gitDiff(root)
    expect(collectGitFiles(binary)).toEqual([{ path: file, lines: [], added: 0, removed: 0, binary: true }])

    git('add', '--', file)
    const trackedBinary = await gitDiff(root)
    expect(collectGitFiles(trackedBinary)).toEqual([{ path: file, lines: [], added: 0, removed: 0, binary: true }])

    fs.writeFileSync(path.join(root, file), 'tracked special-path contents\n')
    const tracked = await gitDiff(root)
    expect(collectGitFiles(tracked)).toEqual([{
      path: file, lines: ['@@ -0,0 +1 @@', '+tracked special-path contents'], added: 1, removed: 0
    }])
  })

  it('finds root-relative untracked paths from a subdirectory and excludes ignored and tracked files', async () => {
    init()
    fs.mkdirSync(path.join(root, 'nested'))
    fs.writeFileSync(path.join(root, 'root file.txt'), 'root untracked contents\n')
    fs.writeFileSync(path.join(root, 'nested', '文件-é.txt'), 'nested untracked contents\n')
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n')
    fs.writeFileSync(path.join(root, 'ignored.txt'), 'ignored contents\n')
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'tracked contents\n')
    git('add', '.gitignore', 'tracked.txt')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Initial')
    git('mv', 'tracked.txt', 'renamed.txt')

    const result = await gitDiff(path.join(root, 'nested'))

    expect(result.error).toBeUndefined()
    expect(result.diff).toContain('+root untracked contents')
    expect(result.diff).toContain('+nested untracked contents')
    expect(result.diff).not.toContain('+ignored contents')
    expect(result.diff).not.toContain('+tracked contents')
    expect(result.status).toBe(git('-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall'))
    expect(result.status).toContain('R  tracked.txt -> renamed.txt')
    expect(collectGitFiles(result).map((file) => file.path).sort()).toEqual(['nested/文件-é.txt', 'renamed.txt', 'root file.txt'])
  })

  it.skipIf(process.platform === 'win32')('keeps showing an untracked symlink target outside the repository', async () => {
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo)
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true })
    fs.writeFileSync(path.join(root, 'outside.txt'), 'external symlink target contents\n')
    fs.symlinkSync('../outside.txt', path.join(repo, 'link.txt'))

    const result = await gitDiff(repo)

    expect(result.error).toBeUndefined()
    expect(result.status).toContain('?? link.txt')
    expect(result.diff).toContain('+external symlink target contents')
    expect(result.diff).not.toContain('+../outside.txt')
  })

})
