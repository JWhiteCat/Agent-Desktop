import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { quoteGitPath } from '@shared/git-path'
import { unifiedDiff } from '@shared/unified-diff'
import type { FileChange } from '@shared/types'

const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_FILES = 5000

interface RepoSnapshot {
  root: string
  files: Map<string, Buffer>
  /** Listed but not captured: never mistake these for newly created files. */
  skipped: Set<string>
}

const newBudget = () => ({ bytes: MAX_TOTAL_BYTES, files: MAX_FILES })

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout))
    child.stdin?.end()
  })
}

async function readRepo(root: string, previousNames: string[] = [], budget = newBudget()): Promise<RepoSnapshot | undefined> {
  const listed = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  if (listed === undefined) return undefined
  const files = new Map<string, Buffer>()
  const skipped = new Set<string>()
  const canonicalRoot = await fs.realpath(root)
  const names = [...new Set([...listed.split('\0').filter(Boolean), ...previousNames])].sort()
  for (const name of names) {
    if (budget.files-- <= 0) { skipped.add(name); continue }
    try {
      const file = path.join(root, name)
      const stat = await fs.lstat(file)
      // Do not follow symlinks or traverse submodules.
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size > budget.bytes) {
        skipped.add(name)
        continue
      }
      const relative = path.relative(canonicalRoot, await fs.realpath(file))
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { skipped.add(name); continue }
      const content = await fs.readFile(file)
      if (content.length > MAX_FILE_BYTES || content.length > budget.bytes) { skipped.add(name); continue }
      files.set(name, content)
      budget.bytes -= content.length
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') skipped.add(name)
    }
  }
  return { root, files, skipped }
}

/** Read working files, without touching the index, HEAD, refs, or Git objects. */
export async function snapshotTurnFiles(cwd: string): Promise<RepoSnapshot[]> {
  if (!cwd) return []
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  const roots: string[] = []
  if (top?.trim()) roots.push(top.trim())
  else {
    // A project can be a container directory, with its code in a child repo.
    try {
      const children = (await fs.readdir(cwd, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
        .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40)
      for (const child of children) {
        const dir = path.join(cwd, child.name)
        try { await fs.lstat(path.join(dir, '.git')); roots.push(dir) } catch { /* not a repository */ }
      }
    } catch { /* missing or unreadable project */ }
  }
  const budget = newBudget()
  const snapshots = await Promise.all(roots.map((root) => readRepo(root, [], budget)))
  return snapshots.filter((snapshot): snapshot is RepoSnapshot => !!snapshot)
}

export async function changedTurnFiles(before: RepoSnapshot[]): Promise<FileChange[]> {
  const changes: FileChange[] = []
  const budget = newBudget()
  for (const repo of before) {
    const after = await readRepo(repo.root, [...repo.files.keys()], budget)
    if (!after) continue
    for (const name of new Set([...repo.files.keys(), ...after.files.keys()])) {
      if (repo.skipped.has(name) || after.skipped.has(name)) continue
      const old = repo.files.get(name)
      const current = after.files.get(name)
      if (old && current && old.equals(current)) continue
      const filePath = path.join(repo.root, name)
      const a = quoteGitPath(`a/${name}`)
      const b = quoteGitPath(`b/${name}`)
      let diff: string
      if (old?.includes(0) || current?.includes(0)) {
        diff = `diff --git ${a} ${b}\nBinary files ${old ? a : '/dev/null'} and ${current ? b : '/dev/null'} differ\n`
      } else {
        diff = unifiedDiff(name, old?.toString('utf8') ?? null, current?.toString('utf8') ?? '').text
        // Empty files and newline-only changes still belong in the file list.
        if (!diff) diff = `diff --git ${a} ${b}\n`
      }
      changes.push({ path: filePath, diff })
    }
  }
  return changes
}
