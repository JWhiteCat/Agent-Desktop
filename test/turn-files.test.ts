import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changedTurnFiles, snapshotTurnFiles } from '../src/main/turn-files'
import { collectSnapshotTurns } from '../src/renderer/src/lib/diff'
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

  it.each(['', 'sub'])('keeps snapshot paths under the selected directory alias (%s)', async (subdir) => {
    git('init', '-q', 'repo')
    const repo = path.join(root, 'repo')
    fs.mkdirSync(path.join(repo, 'sub'))
    write(path.join('repo', subdir, 'file.txt'), 'before\n')
    const alias = path.join(root, 'alias')
    fs.symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const cwd = path.join(alias, subdir)
    const before = await snapshotTurnFiles(cwd)
    write(path.join('repo', subdir, 'file.txt'), 'after\n')
    const changes = await changedTurnFiles(before)
    expect(changes.map(change => change.path)).toEqual([path.join(cwd, 'file.txt')])
    const turns = collectSnapshotTurns([{ id: 'r', kind: 'result', isError: false, fileChanges: changes }], cwd)
    expect(turns[0].files?.map(file => file.path)).toEqual(['file.txt'])
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
    const files = collectSnapshotTurns([{ id: 'r', kind: 'result', isError: false, fileChanges: changes }], root)[0].files!
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

  it('captures ordinary nested files, additions, deletions and renames without creating a Git repository', async () => {
    fs.mkdirSync(path.join(root, 'src'))
    write('src/edited.txt', 'before\n')
    write('deleted.txt', 'gone\n')
    write('old-name.txt', 'renamed\n')
    write('.settings.json', '{}\n')
    const before = await snapshotTurnFiles(root)
    write('src/edited.txt', 'after\n')
    write('src/new.txt', 'created\n')
    write('empty.txt', '')
    write('binary.dat', Buffer.from([0, 1, 2]))
    fs.rmSync(path.join(root, 'deleted.txt'))
    fs.renameSync(path.join(root, 'old-name.txt'), path.join(root, 'new-name.txt'))
    const changes = await changedTurnFiles(before)
    const files = collectSnapshotTurns([{ id: 'r', kind: 'result', isError: false, fileChanges: changes }], root)[0].files!
    expect(files.map((file) => file.path).sort()).toEqual(['binary.dat', 'deleted.txt', 'empty.txt', 'new-name.txt', 'old-name.txt', 'src/edited.txt', 'src/new.txt'])
    expect(files.find((file) => file.path === 'src/edited.txt')).toMatchObject({ added: 1, removed: 1 })
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false)
    expect(await changedTurnFiles(await snapshotTurnFiles(root))).toEqual([])
  })

  it('still records ordinary files when Git is not installed', async () => {
    vi.stubEnv('PATH', root)
    write('plain.txt', 'before\n')
    const before = await snapshotTurnFiles(root)
    write('plain.txt', 'after\n')
    expect((await changedTurnFiles(before)).map((file) => path.basename(file.path))).toEqual(['plain.txt'])
  })

  it('skips dependency, cache, build and oversized files in ordinary directories', async () => {
    for (const dir of ['node_modules', '.cache', '.venv', 'dist', 'build', 'out', '.git']) {
      fs.mkdirSync(path.join(root, dir))
      write(`${dir}/noise.txt`, 'before\n')
    }
    write('large.txt', Buffer.alloc(257 * 1024, 'a'))
    write('actual.txt', 'before\n')
    const before = await snapshotTurnFiles(root)
    for (const dir of ['node_modules', '.cache', '.venv', 'dist', 'build', 'out', '.git']) write(`${dir}/noise.txt`, 'after\n')
    write('large.txt', 'now small\n')
    write('actual.txt', 'after\n')
    expect((await changedTurnFiles(before)).map((file) => path.basename(file.path))).toEqual(['actual.txt'])
  })

  it('keeps Git ignore rules for child repositories while also recording ordinary parent files', async () => {
    git('init', '-q', 'code')
    write('code/.gitignore', 'ignored.txt\n')
    write('code/ignored.txt', 'before\n')
    write('code/source.txt', 'before\n')
    write('notes.txt', 'before\n')
    const before = await snapshotTurnFiles(root)
    write('code/ignored.txt', 'after\n')
    write('code/source.txt', 'after\n')
    write('notes.txt', 'after\n')
    expect((await changedTurnFiles(before)).map((file) => path.relative(root, file.path).replaceAll('\\', '/')).sort()).toEqual(['code/source.txt', 'notes.txt'])
  })

  it('does not follow directory links outside an ordinary project', async () => {
    const project = path.join(root, 'project')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(project)
    fs.mkdirSync(outside)
    write('project/source.txt', 'before\n')
    write('outside/external.txt', 'before\n')
    fs.symlinkSync(outside, path.join(project, 'link'), 'junction')
    const before = await snapshotTurnFiles(project)
    write('outside/external.txt', 'after\n')
    write('project/source.txt', 'after\n')
    expect((await changedTurnFiles(before)).map((file) => path.basename(file.path))).toEqual(['source.txt'])
  })
})
