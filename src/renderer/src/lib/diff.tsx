import { useCallback, useMemo, useRef, useState } from 'react'
import type { GitDiff, Item } from '@shared/types'
import { untrackedGitPaths, fileChangePathKey } from '@shared/git-path'
import { useT } from './i18n'
import { IconChevronDown, IconChevronRight, IconCopy } from '../components/icons'
import { HoverTip } from '../components/HoverTip'
import { ContextMenu } from '../components/Menu'
import { errorText, toast } from '../store/feedback'
import { copyText } from './clipboard'
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

export function DiffFileView({ file, label, defaultOpen = true, onOpen }: {
  file: DiffFile; label?: string; defaultOpen?: boolean; onOpen?: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(defaultOpen)
  const head = useRef<HTMLDivElement>(null)
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = useCallback(() => setPoint(null), [])
  const display = label ?? file.path
  const copy = async (text: string) => {
    try {
      await copyText(text)
      toast(t('已复制'))
    } catch (error) {
      toast(t('无法复制：{error}', { error: errorText(error) }), 'error')
    }
  }
  const keyboardPoint = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    return { x: rect.left, y: rect.bottom }
  }
  const nativeSelectionMenu = () => !window.api.isRemote && !!window.getSelection()?.toString()
  return (
    <div className="diff-file">
      <div
        ref={head}
        className="diff-file-head"
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(event) => {
          if (!file.path) return
          if (nativeSelectionMenu()) {
            closeMenu()
            return
          }
          event.preventDefault()
          event.stopPropagation()
          setPoint(event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : keyboardPoint(event.currentTarget))
        }}
        onKeyDown={(event) => {
          if (!file.path || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return
          event.preventDefault()
          event.stopPropagation()
          setPoint(keyboardPoint(event.currentTarget))
        }}
      >
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        <HoverTip text={display || undefined} disabled={point !== null} block>
          <span
            className="diff-path"
            onDoubleClick={(e) => {
              e.stopPropagation()
              onOpen?.()
            }}
          >
            {display || t('(未知文件)')}
          </span>
        </HoverTip>
        <span className="diff-stat">
          {file.added > 0 && <span className="add">+{file.added}</span>}
          {file.removed > 0 && <span className="del">−{file.removed}</span>}
          {file.binary && <span className="muted">{t('二进制')}</span>}
        </span>
      </div>
      {open && file.unavailable && <div className="notice">{t('差异不可用')}</div>}
      {open && file.lines.length > 0 && <DiffLines lines={file.lines} />}
      <ContextMenu
        point={point}
        anchor={head.current}
        onClose={closeMenu}
        items={[
          { label: t('复制路径'), icon: <IconCopy size={14} />, onSelect: () => void copy(file.path) },
          { label: t('复制文件名'), icon: <IconCopy size={14} />, onSelect: () => void copy(file.path.split('/').pop() ?? file.path) }
        ]}
      />
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
