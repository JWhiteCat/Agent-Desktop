import { decodeGitPath } from './git-path'

export interface DiffFile {
  path: string
  lines: string[]
  added: number
  removed: number
  binary?: boolean
  unavailable?: boolean
}

function diffHeaderPath(paths: string): string {
  const quotedFrom = /^"(?:\\.|[^"\\])*" /.exec(paths)
  if (quotedFrom) return decodeGitPath(paths.slice(quotedFrom[0].length)).replace(/^b\//, '')
  const quotedTo = / ("(?:\\.|[^"\\])*")$/.exec(paths)
  if (quotedTo) return decodeGitPath(quotedTo[1]).replace(/^b\//, '')
  // Spaces are unquoted in native Git diff headers. Match repeated paths before
  // falling back to the separator, which can itself occur inside a filename.
  for (let i = paths.indexOf(' b/'); i !== -1; i = paths.indexOf(' b/', i + 1)) {
    const to = paths.slice(i + 3)
    if (paths.slice(0, i).replace(/^a\//, '') === to) return to
  }
  return / b\/(.+)$/.exec(paths)?.[1] ?? paths
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  if (!text.trim()) return files
  let cur: DiffFile | undefined
  let oldRemaining = 0
  let newRemaining = 0
  const start = (path: string) => {
    cur = { path, lines: [], added: 0, removed: 0 }
    oldRemaining = newRemaining = 0
    files.push(cur)
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      start(diffHeaderPath(line.slice(11)))
      continue
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      if (!cur) start('')
      oldRemaining = Number(hunk[1] ?? 1)
      newRemaining = Number(hunk[2] ?? 1)
      cur!.lines.push(line)
      continue
    }
    // Header-like content inside a hunk is still a changed line (e.g. SQL comments).
    if (cur && (oldRemaining > 0 || newRemaining > 0)) {
      if (line.startsWith('-')) {
        oldRemaining--
        cur.removed++
      } else if (line.startsWith('+')) {
        newRemaining--
        cur.added++
      } else if (line.startsWith(' ')) {
        oldRemaining--
        newRemaining--
      }
      cur.lines.push(line)
      continue
    }
    if (line.startsWith('--- ') && (!cur || cur.lines.some((l) => l.startsWith('@@')))) {
      start('')
    }
    if (!cur) start('')
    const c = cur!
    if (line.startsWith('+++ ')) {
      const p = decodeGitPath(line.slice(4).split('\t')[0]).replace(/^b\//, '')
      if (p !== '/dev/null') c.path = p
      continue
    }
    if (line.startsWith('--- ')) {
      if (!c.path) {
        const p = decodeGitPath(line.slice(4).split('\t')[0]).replace(/^a\//, '')
        if (p !== '/dev/null') c.path = p
      }
      continue
    }
    if (/^(rename to |copy to )/.test(line)) {
      c.path = decodeGitPath(line.replace(/^(rename to |copy to )/, ''))
      continue
    }
    if (/^(index |new file mode|deleted file mode|similarity index|rename from|copy from|old mode|new mode)/.test(line)) continue
    if (line.startsWith('Binary files')) {
      c.binary = true
      continue
    }
    if (line.startsWith('+')) c.added++
    else if (line.startsWith('-')) c.removed++
    c.lines.push(line)
  }
  for (const f of files) while (f.lines.length && !f.lines[f.lines.length - 1]) f.lines.pop()
  return files.filter((f) => f.path || f.lines.length)
}
