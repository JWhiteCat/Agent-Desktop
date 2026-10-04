import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorktree, releaseWorktrees, removeWorktree } from '../src/main/git'
import { isolateGitEnvironment } from './helpers/git-environment'

let root: string
let repo: string
let parent: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }).toString().trim()
const branches = () => git(repo, 'branch', '--format=%(refname:short)').split(/\r?\n/).filter(Boolean)

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-git-'))
  isolateGitEnvironment(root)
  repo = path.join(root, 'repo')
  parent = path.join(root, 'worktrees')
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'sub', 'a.txt'), 'a')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
})
afterEach(() => {
  vi.unstubAllEnvs()
  const resolved = path.resolve(root)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-git-')) {
    throw new Error(`Unexpected test directory: ${resolved}`)
  }
  fs.rmSync(resolved, { recursive: true, force: true })
})

describe('app-created worktrees', () => {
  it('opens the matching subdirectory on a new agent-desktop branch', async () => {
    const dir = await createWorktree(path.join(repo, 'sub'), parent)
    expect(path.basename(dir)).toBe('sub')
    const top = path.dirname(dir)
    expect(path.dirname(top)).toBe(path.join(parent, 'repo'))
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`agent-desktop/${path.basename(top)}`)
  })

  it('removes the worktree and its branch when nothing was committed', async () => {
    const dir = await createWorktree(repo, parent)
    await removeWorktree(dir)
    expect(fs.existsSync(dir)).toBe(false)
    expect(branches()).toEqual(['main'])
  })

  it('keeps a branch that has unmerged commits', async () => {
    const dir = await createWorktree(repo, parent)
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'work')
    await removeWorktree(dir)
    expect(fs.existsSync(dir)).toBe(false)
    expect(branches()).toContain(`agent-desktop/${path.basename(dir)}`)
  })

  it('keeps a worktree with uncommitted changes', async () => {
    const dir = await createWorktree(repo, parent)
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x')
    await expect(removeWorktree(dir)).rejects.toThrow()
    expect(fs.existsSync(path.join(dir, 'dirty.txt'))).toBe(true)
  })

  it('releases only unshared worktrees under the app directory', async () => {
    const shared = await createWorktree(repo, parent)
    const alone = await createWorktree(repo, parent)
    await releaseWorktrees(
      [{ cwd: shared }, { cwd: alone }, { cwd: repo }, {}],
      [{ cwd: shared }],
      parent
    )
    expect(fs.existsSync(shared)).toBe(true)
    expect(fs.existsSync(alone)).toBe(false)
    expect(fs.existsSync(repo)).toBe(true)
  })

  it.each(['root', 'child', 'sibling'] as const)('keeps a worktree used from another %s directory', async (usedFrom) => {
    const shared = await createWorktree(repo, parent)
    const sub = path.join(shared, 'sub')
    const deleted = usedFrom === 'child' ? shared : sub
    const remaining = usedFrom === 'root' ? shared : usedFrom === 'child' ? sub : path.join(shared, 'other')
    await releaseWorktrees([{ cwd: deleted }], [{ cwd: remaining }], parent)
    expect(fs.existsSync(sub)).toBe(true)
    expect(git(shared, 'rev-parse', '--show-toplevel').replace(/\\/g, '/')).toBe(shared.replace(/\\/g, '/'))
  })

  it('removes an unused worktree once when deleted threads used different subdirectories', async () => {
    const dir = await createWorktree(repo, parent)
    await releaseWorktrees([{ cwd: dir }, { cwd: path.join(dir, 'sub') }], [], parent)
    expect(fs.existsSync(dir)).toBe(false)
    expect(branches()).toEqual(['main'])
  })

  it('does not remove a worktree outside the managed parent through a directory link', async () => {
    const outside = await createWorktree(repo, path.join(root, 'outside'))
    fs.mkdirSync(parent, { recursive: true })
    const link = path.join(parent, 'linked')
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    await releaseWorktrees([{ cwd: link }], [], parent)
    expect(fs.existsSync(outside)).toBe(true)
  })
})
