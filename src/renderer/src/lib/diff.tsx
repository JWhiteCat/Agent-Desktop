import { useMemo, useState } from 'react'
import type { Item } from '@shared/types'
import { t } from '@shared/i18n'
import { useT } from './i18n'
import { IconChevronDown, IconChevronRight } from '../components/icons'
import { relativePath } from './format'
import { toolDiff, toolPath } from './tools'

export interface DiffFile {
  path: string
  lines: string[]
  added: number
  removed: number
  binary?: boolean
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  if (!text.trim()) return files
  let cur: DiffFile | undefined
  const start = (path: string) => {
    cur = { path, lines: [], added: 0, removed: 0 }
    files.push(cur)
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.+)$/)
      start(m ? m[1] : line.slice(11))
      continue
    }
    if (line.startsWith('--- ') && (!cur || cur.lines.some((l) => l.startsWith('@@')))) {
      start('')
      continue
    }
    if (!cur) start('')
    const c = cur!
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '')
      if (!c.path && p !== '/dev/null') c.path = p
      continue
    }
    if (line.startsWith('--- ')) {
      if (!c.path) {
        const p = line.slice(4).replace(/^a\//, '')
        if (p !== '/dev/null') c.path = p
      }
      continue
    }
    if (/^(index |new file mode|deleted file mode|similarity index|rename from|rename to|old mode|new mode)/.test(line)) continue
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

/** Edits in one turn, grouped by path. Later edits of the same file append. */
export function collectEditedFiles(items: Item[], cwd?: string): DiffFile[] {
  const byPath = new Map<string, DiffFile>()
  for (const it of items) {
    if (it.kind !== 'tool') continue
    const diff = toolDiff(it)
    if (!diff) continue
    for (const file of parseUnifiedDiff(diff)) {
      const p = relativePath(file.path || toolPath(it) || t('(未知文件)'), cwd).replace(/\\/g, '/')
      const prev = byPath.get(p)
      if (!prev) {
        byPath.set(p, { ...file, path: p })
        continue
      }
      prev.lines.push(...file.lines)
      prev.added += file.added
      prev.removed += file.removed
      prev.binary = prev.binary || file.binary
    }
  }
  return [...byPath.values()]
}

export function DiffLines({ lines }: { lines: string[] }) {
  return (
    <div className="diff-lines">
      {lines.map((l, i) => {
        const cls = l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('\\') ? 'meta' : ''
        return (
          <div key={i} className={`diff-line ${cls}`}>
            {l || ' '}
          </div>
        )
      })}
    </div>
  )
}

export function DiffFileView({ file, defaultOpen = true, onOpen }: { file: DiffFile; defaultOpen?: boolean; onOpen?: () => void }) {
  const t = useT()
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="diff-file">
      <div className="diff-file-head" onClick={() => setOpen((o) => !o)}>
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        <span
          className="diff-path"
          onDoubleClick={(e) => {
            e.stopPropagation()
            onOpen?.()
          }}
        >
          {file.path || t('(未知文件)')}
        </span>
        <span className="diff-stat">
          {file.added > 0 && <span className="add">+{file.added}</span>}
          {file.removed > 0 && <span className="del">−{file.removed}</span>}
          {file.binary && <span className="muted">{t('二进制')}</span>}
        </span>
      </div>
      {open && file.lines.length > 0 && <DiffLines lines={file.lines} />}
    </div>
  )
}

export function DiffView({ text }: { text: string }) {
  const files = useMemo(() => parseUnifiedDiff(text), [text])
  return (
    <>
      {files.map((f, i) => (
        <DiffFileView key={i} file={f} />
      ))}
    </>
  )
}
