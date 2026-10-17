import { useMemo, useState } from 'react'
import type { GitDiff, Item } from '@shared/types'
import { untrackedGitPaths, fileChangePathKey } from '@shared/git-path'
import { useT } from './i18n'
import { IconChevronDown, IconChevronRight } from '../components/icons'
import { relativePath } from './format'

export { parseUnifiedDiff, type DiffFile } from '@shared/parsed-diff'
import { parseUnifiedDiff, type DiffFile } from '@shared/parsed-diff'

/** Include status-only files (e.g. beyond the untracked diff limit) without duplicates. */
export function collectGitFiles(git: Pick<GitDiff, 'diff' | 'status'>): DiffFile[] {
  const files = parseUnifiedDiff(git.diff)
  const known = new Set(files.map((file) => file.path))
  for (const path of untrackedGitPaths(git.status)) {
    if (known.has(path)) continue
    files.push({ path, lines: [], added: 0, removed: 0 })
    known.add(path)
  }
  return files
}

/** Only operation-owned records belong in the agent's edited-file list. */
export function collectEditedFiles(items: Item[], cwd?: string): DiffFile[] {
  const byPath = new Map<string, DiffFile>()
  let seen = new Set<string>()
  for (const item of items) {
    if (item.kind === 'user') { seen = new Set(); continue }
    if (item.kind !== 'tool' || item.status !== 'success' || seen.has(item.callId)) continue
    seen.add(item.callId)
    for (const change of item.fileChanges ?? []) {
      const p = relativePath(change.path, cwd).replace(/\\/g, '/')
      const parsed = change.diff ? parseUnifiedDiff(change.diff)[0] : undefined
      const file: DiffFile = { path: p, lines: parsed?.lines ?? [], added: parsed?.added ?? 0,
        removed: parsed?.removed ?? 0, binary: change.binary || parsed?.binary,
        unavailable: !change.diff }
      const key = fileChangePathKey(change.path)
      const previous = byPath.get(key)
      if (!previous) byPath.set(key, file)
      else {
        previous.lines.push(...file.lines)
        previous.added += file.added
        previous.removed += file.removed
        previous.binary ||= file.binary
        previous.unavailable ||= file.unavailable
      }
    }
  }
  return [...byPath.values()]
}

export interface SnapshotTurn {
  id: string
  number: number
  summary: string
  files?: DiffFile[]
}

/** Saved end-of-turn workspace observations, never tool attribution. */
export function collectSnapshotTurns(items: Item[], cwd?: string, running = false): SnapshotTurn[] {
  const turns: SnapshotTurn[] = []
  let user: Extract<Item, { kind: 'user' }> | undefined
  let result: Extract<Item, { kind: 'result' }> | undefined
  let number = 0
  const flush = () => {
    if (!user && !result) return
    turns.push({ id: user?.id ?? result!.id, number: number || 1,
      summary: user?.text.split(/\r?\n/)[0].slice(0, 80) ?? '',
      files: result?.fileChanges?.map((change) => ({
        ...(parseUnifiedDiff(change.diff)[0] ?? { lines: [], added: 0, removed: 0 }),
        path: relativePath(change.path, cwd).replace(/\\/g, '/')
      })) })
  }
  for (const item of items) {
    if (item.kind === 'user') { flush(); user = item; number++; result = undefined }
    else if (item.kind === 'result') result = item
  }
  if (!running) flush()
  return turns
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
      {open && file.unavailable && <div className="notice">{t('差异不可用')}</div>}
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
