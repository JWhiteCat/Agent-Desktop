import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { t as translate } from '@shared/i18n'
import path from 'node:path'
import type { GitDiff } from '@shared/types'

const MAX_UNTRACKED_FILES = 60
const MAX_UNTRACKED_BYTES = 256 * 1024

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: stdout, err: stderr || (error ? String(error) : '') })
    })
    child.stdin?.end()
  })
}

/** `git diff` ignores untracked files, so render them as whole-file additions. */
function untrackedDiff(root: string, rel: string): string {
  const header = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`
  try {
    const file = path.join(root, rel)
    const stat = fs.statSync(file)
    if (!stat.isFile()) return ''
    if (stat.size > MAX_UNTRACKED_BYTES) return `${header}@@ ${translate('文件过大（{size} KB），未显示', { size: Math.round(stat.size / 1024) })} @@\n`
    const buf = fs.readFileSync(file)
    if (buf.includes(0)) return `diff --git a/${rel} b/${rel}\nBinary files /dev/null and b/${rel} differ\n`
    const lines = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
    if (lines.length === 1 && lines[0] === '') return header
    return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`
  } catch {
    return ''
  }
}

export const WORKTREE_BRANCH_PREFIX = 'agent-desktop/'

/**
 * Adds a worktree at the project's HEAD under `parent/<repo>/<name>`, on a new branch
 * `agent-desktop/<name>`. Uncommitted changes stay in the project.
 * Returns the directory matching `project` inside the worktree.
 */
export async function createWorktree(project: string, parent: string): Promise<string> {
  const top = await git(project, ['rev-parse', '--show-toplevel'])
  if (!top.ok) throw new Error(translate('项目不是 git 仓库，无法创建 worktree'))
  const root = path.resolve(top.out.trim())
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const label = (branch.ok ? branch.out.trim() : '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'head'
  const name = `${label}-${randomUUID().slice(0, 8)}`
  const dir = path.join(parent, path.basename(root), name)
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  const added = await git(root, ['worktree', 'add', '-b', `${WORKTREE_BRANCH_PREFIX}${name}`, dir, 'HEAD'])
  if (!added.ok) throw new Error(translate('无法创建 worktree：{error}', { error: added.err.trim() }))
  const inner = path.join(dir, path.relative(root, path.resolve(project)))
  return fs.existsSync(inner) ? inner : dir
}

const REMOVE_ATTEMPTS = 10
const REMOVE_RETRY_MS = 500

/**
 * Removes the worktree containing `dir`, then its `agent-desktop/` branch if that branch is merged.
 * Unmerged commits keep the branch. A worktree with uncommitted or untracked files is kept.
 * Retries while the killed CLI process may still hold the directory open.
 */
export async function removeWorktree(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) return
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return
  const root = path.resolve(top.out.trim())
  const [common, branch] = await Promise.all([
    git(root, ['rev-parse', '--git-common-dir']),
    git(root, ['symbolic-ref', '-q', '--short', 'HEAD'])
  ])
  if (!common.ok) throw new Error(common.err.trim())
  // Running from the shared git directory keeps git itself out of the directory being removed.
  const gitDir = path.resolve(root, common.out.trim())
  let removed = await git(gitDir, ['worktree', 'remove', root])
  for (let i = 1; !removed.ok && i < REMOVE_ATTEMPTS && !/modified or untracked/.test(removed.err); i++) {
    await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_MS))
    removed = await git(gitDir, ['worktree', 'remove', root])
  }
  if (!removed.ok) throw new Error(removed.err.trim())
  const name = branch.ok ? branch.out.trim() : ''
  if (name.startsWith(WORKTREE_BRANCH_PREFIX)) await git(gitDir, ['branch', '-d', name])
}

/** Removes app-created worktrees under `parent` that no remaining thread still uses. */
export async function releaseWorktrees(deleted: Array<{ cwd?: string }>, remaining: Array<{ cwd?: string }>, parent: string): Promise<void> {
  const canonical = (dir: string) => {
    try {
      return fs.realpathSync.native(dir)
    } catch {
      return path.resolve(dir)
    }
  }
  const inside = (root: string, dir: string) => {
    const rel = path.relative(root, dir)
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  }
  const key = (dir: string) => process.platform === 'win32' ? dir.toLowerCase() : dir
  const parentRoot = canonical(parent)
  const used = remaining.flatMap((t) => t.cwd ? [canonical(t.cwd)] : [])
  const dirs = new Map<string, string>()
  for (const t of deleted) {
    if (!t.cwd || !inside(parentRoot, canonical(t.cwd))) continue
    const top = await git(t.cwd, ['rev-parse', '--show-toplevel'])
    if (!top.ok) continue
    const root = canonical(top.out.trim())
    // Validate the directory Git will actually remove, including symlink targets.
    if (key(root) === key(parentRoot) || !inside(parentRoot, root)) continue
    if (!used.some((dir) => inside(root, dir))) dirs.set(key(root), root)
  }
  await Promise.all([...dirs.values()].map(async (dir) => {
    try {
      await removeWorktree(dir)
    } catch (err) {
      console.error('[worktree] remove failed', dir, err)
    }
  }))
}

export async function gitDiff(cwd: string): Promise<GitDiff> {
  const inside = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (!inside.ok) return { isRepo: false, status: '', diff: '' }
  const root = inside.out.trim()
  const [branch, status, hasHead] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall']),
    git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])
  ])
  // Comparing with an empty tree includes edits after staging even before the
  // first commit. hash-object respects the repository's hash format and does
  // not write an object without -w.
  const base = hasHead.ok ? 'HEAD' : (await git(root, ['hash-object', '-t', 'tree', '--stdin'])).out.trim()
  const diff = await git(root, [
    '-c',
    'core.quotepath=false',
    'diff',
    base,
    '--no-color',
    '--no-ext-diff'
  ])
  const untracked = status.out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
  const extra = untracked.slice(0, MAX_UNTRACKED_FILES).map((rel) => untrackedDiff(root, rel)).join('')
  let text = diff.out + extra
  if (text.length > 2_000_000) text = `${text.slice(0, 2_000_000)}\n… (${translate('diff 过大，已截断')})`
  return {
    isRepo: true,
    branch: branch.ok ? branch.out.trim() : undefined,
    status: status.out,
    diff: text,
    error: diff.ok ? undefined : diff.err
  }
}
