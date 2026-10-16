import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changedTurnFiles, snapshotTurnFiles } from '../src/main/turn-files'
import { collectEditedFiles } from '../src/renderer/src/lib/diff'
import { isolateGitEnvironment } from './helpers/git-environment'

describe('turn working-file snapshots', () => {
  let root: string
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'pipe' })
  const write = (name: string, text: string | Buffer) => fs.writeFileSync(path.join(root, name), text)
  const init = () => {
    git('init', '-q')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('config', 'core.autocrlf', 'false')
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-turn-files-'))
    isolateGitEnvironment(root)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    const resolved = path.resolve(root)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-turn-files-')) throw new Error('Unexpected test directory')
    fs.rmSync(resolved, { recursive: true, force: true })
  })

  it('captures script edits even when committed, without counting existing dirty files or touching the index', async () => {
    init()
    write('edited.txt', 'original\n')
    write('dirty.txt', 'original\n')
    git('add', '.')
    git('commit', '-qm', 'Initial')
    write('dirty.txt', 'pre-existing edit\n')
    git('add', 'dirty.txt')
    const index = fs.readFileSync(path.join(root, '.git/index'))
    const before = await snapshotTurnFiles(root)
    expect(fs.readFileSync(path.join(root, '.git/index'))).toEqual(index)
    write('edited.txt', 'script edit\n')
    git('add', '.')
    git('commit', '-qm', 'Script edit')
    const changes = await changedTurnFiles(before)
    expect(changes).toHaveLength(1)
    expect(changes[0].path).toBe(path.join(root, 'edited.txt'))
    expect(changes[0].diff).toContain('-original\n+script edit')
    expect(git('status', '--porcelain')).toBe('')
    expect(await changedTurnFiles(await snapshotTurnFiles(root))).toEqual([])
  })

  it('supports a project container with a direct child repository, as in the reported session', async () => {
    git('init', '-q', 'code')
    write('code/script.py', 'before\n')
    const before = await snapshotTurnFiles(root)
    write('code/script.py', 'after\n')
    expect((await changedTurnFiles(before)).map((file) => path.relative(root, file.path))).toEqual([path.join('code', 'script.py')])
  })

  it('tracks additions, deletions, empty files, binary files, and an unborn repository; skips ignored and oversized files', async () => {
    init()
    write('.gitignore', 'ignored.txt\n')
    write('deleted.txt', 'gone\n')
    write('large.txt', Buffer.alloc(257 * 1024, 'a'))
    git('add', '.')
    const before = await snapshotTurnFiles(root)
    fs.rmSync(path.join(root, 'deleted.txt'))
    write('new file.txt', 'new\n')
    write('empty.txt', '')
    write('binary.dat', Buffer.from([0, 1, 2]))
    write('ignored.txt', 'hidden\n')
    write('large.txt', 'now small\n')
    const changes = await changedTurnFiles(before)
    const files = collectEditedFiles([{ id: 'r', kind: 'result', isError: false, fileChanges: changes }], root)
    expect(files.map((file) => file.path).sort()).toEqual(['binary.dat', 'deleted.txt', 'empty.txt', 'new file.txt'])
    expect(files.find((file) => file.path === 'binary.dat')?.binary).toBe(true)
    expect(files.find((file) => file.path === 'deleted.txt')?.removed).toBe(1)
  })

  it('does not report removing a file from the index or changing ignore rules as deleting working content', async () => {
    init()
    write('kept.txt', 'same\n')
    git('add', '.')
    const before = await snapshotTurnFiles(root)
    git('rm', '--cached', 'kept.txt')
    write('.gitignore', 'kept.txt\n')
    expect((await changedTurnFiles(before)).map((file) => path.basename(file.path))).toEqual(['.gitignore'])
  })
})
