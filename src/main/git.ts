import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { GitDiff } from '@shared/types'

const MAX_UNTRACKED_FILES = 60
const MAX_UNTRACKED_BYTES = 256 * 1024

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: stdout, err: stderr || (error ? String(error) : '') })
    })
  })
}

/** `git diff` ignores untracked files, so render them as whole-file additions. */
function untrackedDiff(root: string, rel: string): string {
  const header = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`
  try {
    const file = path.join(root, rel)
    const stat = fs.statSync(file)
    if (!stat.isFile()) return ''
    if (stat.size > MAX_UNTRACKED_BYTES) return `${header}@@ 文件过大（${Math.round(stat.size / 1024)} KB），未显示 @@\n`
    const buf = fs.readFileSync(file)
    if (buf.includes(0)) return `diff --git a/${rel} b/${rel}\nBinary files /dev/null and b/${rel} differ\n`
    const lines = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
    if (lines.length === 1 && lines[0] === '') return header
    return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`
  } catch {
    return ''
  }
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
  const diff = await git(root, [
    '-c',
    'core.quotepath=false',
    'diff',
    ...(hasHead.ok ? ['HEAD'] : ['--cached']),
    '--no-color',
    '--no-ext-diff'
  ])
  const untracked = status.out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
  const extra = untracked.slice(0, MAX_UNTRACKED_FILES).map((rel) => untrackedDiff(root, rel)).join('')
  let text = diff.out + extra
  if (text.length > 2_000_000) text = `${text.slice(0, 2_000_000)}\n… (diff 过大，已截断)`
  return {
    isRepo: true,
    branch: branch.ok ? branch.out.trim() : undefined,
    status: status.out,
    diff: text,
    error: diff.ok ? undefined : diff.err
  }
}
