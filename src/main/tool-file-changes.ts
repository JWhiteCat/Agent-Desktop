import path from 'node:path'
import type { Item, ToolFileChange, ToolItem } from '@shared/types'
import { parseUnifiedDiff } from '@shared/parsed-diff'
import { quoteGitPath, fileChangePathKey } from '@shared/git-path'
import { unifiedDiff } from '@shared/unified-diff'

const EDIT_TOOLS = new Set(['edit', 'write', 'writefile', 'searchreplace', 'strreplace', 'multiedit', 'applypatch', 'delete', 'deletefile', 'move', 'rename'])
const MAX_FILE_BYTES = 256 * 1024
const MAX_TURN_BYTES = 16 * 1024 * 1024

function absolute(file: string, cwd: string): string | undefined {
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd) || /^[A-Za-z]:[\\/]|^\\\\/.test(file) ? path.win32 : path.posix
  return paths.isAbsolute(file) ? paths.normalize(file) : cwd ? paths.resolve(cwd, file) : undefined
}

/** Extract only structured mutation evidence, never stdout or a workspace read. */
export function extractToolFileChanges(item: ToolItem, cwd: string, args: any = item.args,
  result: any = item.result, content?: unknown): ToolFileChange[] | undefined {
  const output = result?.success ?? result
  const records: ToolFileChange[] = []
  let hasDiff = false
  if (Array.isArray(content)) for (const block of content) {
    if (block?.type !== 'diff' || typeof block.path !== 'string' || !block.path || typeof block.newText !== 'string') continue
    const targetPath = absolute(block.path, cwd)
    if (!targetPath) continue
    hasDiff = true
    if (block.oldText === block.newText) {
      records.push({ path: targetPath, source: 'tool-result', diff: '' })
      continue
    }
    // Missing before-text is unknown, unlike an explicit null (creation).
    const knownBefore = block.oldText === null || typeof block.oldText === 'string'
    const binary = typeof block.oldText === 'string' && block.oldText.includes('\0') || block.newText.includes('\0')
    records.push({ path: targetPath, source: 'tool-result', binary: binary || undefined,
      diff: knownBefore && !binary ? unifiedDiff(block.path, block.oldText, block.newText).text
        || `diff --git ${quoteGitPath(`a/${block.path}`)} ${quoteGitPath(`b/${block.path}`)}\n` : undefined })
  }
  if (hasDiff) return records
  if (typeof output?.diffString === 'string' && output.diffString.trim() && !isCompacted(output.diffString)) {
    // Parse each section once; repeated parsing is quadratic for large multi-file calls.
    const parts: string[] = output.diffString.split(/(?=^diff --git )/m).filter((part: string) => part.trim())
    for (const part of parts) {
      const files = parseUnifiedDiff(part)
      for (const file of files) {
        if (!file.path) continue
        const targetPath = absolute(file.path, cwd)
        // Legacy bare multi-file patches do not have unambiguous section boundaries.
        if (targetPath) records.push({ path: targetPath, diff: files.length === 1 ? part : undefined,
          binary: file.binary, source: 'tool-result' })
      }
    }
    return records
  }
  const name = item.tool.toLowerCase().replace(/[^a-z]/g, '')
  if (!EDIT_TOOLS.has(name)) return undefined
  const targets = new Set<string>()
  const target = args?.path ?? args?.targetFile ?? args?.filePath ?? args?.file_path ?? args?.file
  if (typeof target === 'string' && target) targets.add(target)
  const patch = typeof args === 'string' ? args : typeof args?.patch === 'string' ? args.patch : undefined
  if (patch) for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) targets.add((match[1] ?? match[2]).trim())
  for (const target of targets) {
    const targetPath = absolute(target, cwd)
    if (targetPath) records.push({ path: targetPath, source: 'edit-input' })
  }
  return records.length ? records : undefined
}

function isCompacted(text: string): boolean {
  return /\n… \((?:已截断 \d+ 字符|\d+ characters truncated)\)$/.test(text)
}

/** One recorder per turn: repeated status updates do not spend the budget twice. */
export class ToolFileRecorder {
  private calls = new Map<string, ToolFileChange[]>()
  private noops = new Map<string, Set<string>>()

  seed(item: ToolItem): void {
    this.calls.set(item.callId, item.fileChanges ?? [])
  }

  record(item: ToolItem, cwd: string, args: any = item.args, result: any = item.result, content?: unknown): void {
    const next = extractToolFileChanges(item, cwd, args, result, content)
    const previous = this.calls.get(item.callId) ?? item.fileChanges ?? []
    const merged = new Map(previous.map((file) => [fileChangePathKey(file.path), file]))
    const noops = this.noops.get(item.callId) ?? new Set<string>()
    this.noops.set(item.callId, noops)
    for (const file of next ?? []) {
      const key = fileChangePathKey(file.path)
      if (file.diff === '') { noops.add(key); merged.delete(key); continue }
      if (file.source === 'edit-input' && noops.has(key)) continue
      noops.delete(key)
      const saved = merged.get(key)
      if (file.source === 'edit-input' && saved?.source === 'tool-result') continue
      merged.set(key, file)
    }
    const files = item.status === 'error' ? [] : [...merged.values()]
    let remaining = MAX_TURN_BYTES
    for (const [id, records] of this.calls) if (id !== item.callId) {
      for (const record of records) remaining -= Buffer.byteLength(record.diff ?? '')
    }
    item.fileChanges = files.map((file) => {
      const bytes = Buffer.byteLength(file.diff ?? '')
      if (bytes > MAX_FILE_BYTES || bytes > remaining) return { ...file, diff: undefined, diffOmitted: true }
      remaining -= bytes
      return file
    })
    this.calls.set(item.callId, item.fileChanges)
  }
}

/** Conservative upgrade of saved tools: a success flag alone is not a completion record. */
export function restoreToolFileChanges(items: Item[], cwd: string): boolean {
  let recorder = new ToolFileRecorder()
  let changed = false
  for (const item of items) {
    if (item.kind === 'user') recorder = new ToolFileRecorder()
    if (item.kind !== 'tool') continue
    if (item.fileChanges !== undefined) { recorder.seed(item); continue }
    if (item.status !== 'success' || item.result?.success === undefined || item.result?.error !== undefined
      || item.result?.failure !== undefined || item.result?.rejected !== undefined) continue
    const success = item.result.success
    if (typeof success?.stdout === 'string' && /^(?:Error:|error:|Failed)/.test(success.stdout)) continue
    if (item.tool.toLowerCase().replace(/[^a-z]/g, '') === 'applypatch' && !success?.diffString
      && !/^Success\. Updated the following files:/m.test(success?.stdout ?? '')) continue
    recorder.record(item, cwd)
    changed = true
  }
  return changed
}
