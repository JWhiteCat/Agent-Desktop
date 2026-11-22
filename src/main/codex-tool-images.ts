import fs from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexSessionsRoot, findCodexRollout, readRolloutHead, walkRollouts } from './codex-rollouts'
import { samePath } from './local-files'

export interface ImageEvidence {
  path?: string
  output?: unknown
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CWD_IN_PREFIX = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/

let turnCacheRoot = ''
let turnRollouts = new Map<string, string>()

function useTurnCache(): Map<string, string> {
  const root = codexSessionsRoot()
  if (root !== turnCacheRoot) {
    turnCacheRoot = root
    turnRollouts = new Map()
  }
  return turnRollouts
}

export function normalizeLocalPath(raw: unknown, cwd?: string): string | undefined {
  if (typeof raw !== 'string' || !raw) return
  let file = raw
  if (/^file:/i.test(file)) {
    const url = new URL(file)
    if (url.hostname || url.search || url.hash) return
    file = fileURLToPath(url)
  }
  if (file.includes('\0') || /^[\\/]{2}/.test(file)) return
  if (process.platform === 'win32' && /^\/[a-zA-Z]:[\\/]/.test(file)) file = file.slice(1)
  if (/^[a-z][a-z0-9+.-]*:/i.test(file) && !/^[a-z]:[\\/]/i.test(file)) return
  if (!path.isAbsolute(file) && (!cwd || !path.isAbsolute(cwd))) return
  const target = path.resolve(cwd ?? '', file)
  if (/^[\\/]{2}/.test(target)) return
  if (process.platform === 'win32') {
    // Reject alternate streams and DOS devices even when they have an image extension.
    if (!/^[a-z]:[\\/]/i.test(target) || target.slice(2).includes(':')
      || /(?:^|[\\/])(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|[\\/]|$)/i.test(target)) return
    if (path.isAbsolute(file) && !/^[a-z]:[\\/]/i.test(file)) return
  }
  return target
}

function isInlineImageBlock(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const x = value as any
  if (x.type === 'image') return typeof x.data === 'string' || (x.source?.type === 'base64' && typeof x.source.data === 'string')
  if (x.type === 'resource') return typeof x.resource?.blob === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(x.resource.mimeType ?? '')
  if (x.type === 'input_image' || x.type === 'image_url') {
    const uri = x.image_url?.url ?? x.image_url
    return typeof uri === 'string' && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(uri)
  }
  return false
}

interface ScanOptions {
  chatId?: string
  turnId?: string
  cwd: string
  callId: string
  expected: string
}

async function scanRollout(rollout: string, opts: ScanOptions): Promise<ImageEvidence | undefined> {
  const handle = await open(rollout, 'r')
  try {
    let sessionId: string | undefined
    let nativeCwd: string | undefined
    const evidence: ImageEvidence = {}
    let directCall = false
    const openExecs = new Map<string, string>() // call_id -> JSON.stringify(call_id)
    let execImageViews = 0
    let matchedExecId: string | undefined
    const quotedId = JSON.stringify(opts.callId)
    for await (const line of handle.readLines()) {
      if (!line.trim()) continue
      if (sessionId) {
        // Fast path: close unrelated exec outputs without parsing huge base64 lines.
        if (openExecs.size && line.includes('"custom_tool_call_output"')) {
          let closedId: string | undefined
          for (const [id, quoted] of openExecs) {
            if (line.includes(quoted)) { closedId = id; break }
          }
          if (closedId && closedId !== matchedExecId) {
            openExecs.delete(closedId)
            if (!openExecs.size) execImageViews = 0
            continue
          }
        }
        const wantExecOutput = matchedExecId !== undefined && execImageViews === 1
          && line.includes('"custom_tool_call_output"') && line.includes(openExecs.get(matchedExecId) ?? JSON.stringify(matchedExecId))
        if (!wantExecOutput && !line.includes(quotedId) && !line.includes('"session_meta"')
          && !line.includes('"ImageView"') && !line.includes('"custom_tool_call"')) continue
      }
      const row = JSON.parse(line)
      const p = row?.payload
      if (row?.type === 'session_meta') {
        if (opts.chatId) {
          if (p?.id !== opts.chatId) return
        } else {
          if (typeof p?.id !== 'string' || !p.id || typeof p?.cwd !== 'string' || !samePath(p.cwd, opts.cwd)) return
        }
        sessionId = p.id
        nativeCwd = p.cwd
        continue
      }
      if (!sessionId) return
      if (row?.type === 'response_item' && p?.type === 'custom_tool_call' && p.name === 'exec' && typeof p.call_id === 'string') {
        openExecs.set(p.call_id, JSON.stringify(p.call_id))
        if (openExecs.size > 1) matchedExecId = undefined
        continue
      }
      if (row?.type === 'response_item' && p?.type === 'custom_tool_call_output' && typeof p.call_id === 'string' && openExecs.has(p.call_id)) {
        const isMatched = p.call_id === matchedExecId && execImageViews === 1
        openExecs.delete(p.call_id)
        if (!openExecs.size) execImageViews = 0
        if (isMatched) {
          matchedExecId = undefined
          if (p.is_error !== true && Array.isArray(p.output)) {
            const images = p.output.filter(isInlineImageBlock)
            // Attribute inline exec output only when a single ImageView corresponds to a single returned image.
            if (images.length === 1 && evidence.output === undefined) evidence.output = images
          }
        }
        continue
      }
      if (row?.type === 'event_msg' && p?.type === 'item_completed' && p.item?.type === 'ImageView') {
        if (openExecs.size === 1) execImageViews++
        if (p.item.id === opts.callId) {
          if (evidence.path || (p.thread_id !== undefined && p.thread_id !== sessionId)) return
          if (opts.turnId && p.turn_id !== opts.turnId) return
          const target = normalizeLocalPath(p.item.path)
          if (!target || !samePath(target, opts.expected)) return
          evidence.path = target
          if (openExecs.size === 1 && execImageViews === 1) matchedExecId = openExecs.keys().next().value
        } else if (matchedExecId) {
          matchedExecId = undefined
        }
        continue
      }
      if (row?.type === 'event_msg' && p?.type === 'item_completed' && p.item?.id === opts.callId) {
        return
      }
      if (row?.type !== 'response_item' || p?.call_id !== opts.callId) continue
      if (p.type === 'function_call') {
        if (opts.turnId) return
        if (directCall || p.name !== 'view_image') return
        const args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments
        const target = normalizeLocalPath(args?.path ?? args?.local_image_path, nativeCwd)
        if (!target || !samePath(target, opts.expected)) return
        directCall = true
      } else if (p.type === 'function_call_output') {
        if (!directCall || evidence.output !== undefined || p.is_error === true || p.output == null) return
        evidence.output = p.output
      } else return
    }
    if (evidence.path || evidence.output !== undefined) return evidence
  } finally {
    await handle.close()
  }
}

function headerCwd(file: string): string | undefined {
  try {
    const m = CWD_IN_PREFIX.exec(readRolloutHead(file, 4096))
    return m ? JSON.parse(`"${m[1]}"`) : undefined
  } catch {
    return undefined
  }
}

/** Only native ImageView completions attest to files outside the conversation's normal scope. */
export async function codexImageEvidence(chatId: string, callId: string, file: string, cwd: string): Promise<ImageEvidence | undefined> {
  if (!chatId || !callId) return
  try {
    const expected = normalizeLocalPath(file, cwd)
    if (!expected) return
    const rollout = findCodexRollout(chatId)
    if (!rollout) return
    return await scanRollout(rollout, { chatId, cwd, callId, expected })
  } catch {
    // The rollout may be unavailable, rotated, or end in an incomplete JSONL record.
  }
}

/** Recovers Codex ImageView evidence for a turn after the thread switched CLI and replaced its chatId. */
export async function codexImageEvidenceByTurn(turnId: string, callId: string, file: string, cwd: string): Promise<ImageEvidence | undefined> {
  if (!UUID.test(turnId) || !callId || !cwd) return
  try {
    const expected = normalizeLocalPath(file, cwd)
    if (!expected) return
    const cache = useTurnCache()
    const cached = cache.get(turnId)
    if (cached) {
      if (fs.existsSync(cached)) return await scanRollout(cached, { turnId, cwd, callId, expected })
      cache.delete(turnId)
    }
    const root = codexSessionsRoot()
    if (!fs.existsSync(root)) return
    const candidates: { file: string; mtimeMs: number }[] = []
    for (const rollout of walkRollouts(root)) {
      const rolloutCwd = headerCwd(rollout)
      if (!rolloutCwd || !samePath(rolloutCwd, cwd)) continue
      try {
        candidates.push({ file: rollout, mtimeMs: fs.statSync(rollout).mtimeMs })
      } catch {
        /* skip vanished rollouts */
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const { file: rollout } of candidates) {
      const evidence = await scanRollout(rollout, { turnId, cwd, callId, expected }).catch(() => undefined)
      if (evidence) {
        cache.set(turnId, rollout)
        return evidence
      }
    }
  } catch {
    // Rollouts may be unavailable or in the middle of being written.
  }
}
