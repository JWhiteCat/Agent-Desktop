import fs from 'node:fs'
import type { AssistantItem, Item, ToolItem } from '@shared/types'
import { findCodexRollout } from './codex-rollouts'

export interface TranscriptRow {
  row: any
  line: number
}

export function parseRolloutLines(text: string): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const [line, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue
    try {
      rows.push({ row: JSON.parse(raw), line })
    } catch {
      /* skip a torn line at the end of a partial read */
    }
  }
  return rows
}

/** Restore separators only when complete native messages prove a legacy concatenation. */
export function repairCodexAssistantMessages(chatId: string, items: Item[]): boolean {
  const candidates = new Map<string, AssistantItem[]>()
  for (const item of items) {
    if (item.kind !== 'assistant' || item.messageId !== undefined || !item.text) continue
    const matches = candidates.get(item.text) ?? []
    matches.push(item)
    candidates.set(item.text, matches)
  }
  if (!candidates.size) return false

  let text: string
  try {
    const file = findCodexRollout(chatId)
    if (!file) return false
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return false
  }

  const groups = nativeAssistantGroups(parseRolloutLines(text))
  let changed = false
  for (const [savedText, matches] of candidates) {
    const repaired = nativeAssistantReplacement(groups, savedText)
    if (repaired === undefined || repaired === savedText) continue
    for (const item of matches) {
      item.text = repaired
      changed = true
    }
  }
  return changed
}

/** Event records duplicate response items; only the complete response text is authoritative. */
function nativeAssistantGroups(rows: TranscriptRow[]): string[][] {
  const groups: string[][] = []
  let current: string[] = []
  const boundary = (): void => {
    if (current.length) groups.push(current)
    current = []
  }
  let previousLine = -1
  for (const { row, line } of rows) {
    // Missing/invalid records cannot prove that two messages were adjacent.
    if (previousLine >= 0 && line > previousLine + 1) boundary()
    previousLine = line
    const payload = row?.payload
    if (row?.type === 'response_item') {
      if (payload?.type === 'message' && payload.role === 'assistant') {
        const content = payload.content
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content) && content.every((block) => block && typeof block.text === 'string')
            ? content.map((block) => block.text).join('')
            : undefined
        if (text) current.push(text)
        else boundary()
      } else if (payload?.type !== 'reasoning') {
        boundary()
      }
    } else if (row?.type === 'event_msg') {
      const type = String(payload?.type ?? '')
      if (type === 'item_started' || type === 'item_completed') {
        const itemType = String(payload.item?.type ?? '').toLowerCase()
        if (itemType !== 'agentmessage' && itemType !== 'reasoning') boundary()
      } else if (type !== 'agent_message' && type !== 'token_count') {
        boundary()
      }
    }
  }
  boundary()
  return groups
}

function nativeAssistantReplacement(groups: string[][], savedText: string): string | undefined {
  if (groups.some((group) => group.includes(savedText))) return undefined
  let replacement: string | undefined
  for (const group of groups) {
    for (let start = 0; start < group.length - 1; start++) {
      let concatenated = ''
      let separated = ''
      for (let end = start; end < group.length; end++) {
        concatenated += group[end]
        separated += `${end === start ? '' : '\n\n'}${group[end]}`
        if (end > start) {
          // A repaired text is recognizable on every reload, even if a different
          // native sequence could also interpret it as an unseparated reply.
          if (separated === savedText) return undefined
          if (concatenated === savedText) {
            if (replacement !== undefined && replacement !== separated) return undefined
            replacement = separated
          }
        }
        if (!savedText.startsWith(concatenated) && !savedText.startsWith(separated)) break
      }
    }
  }
  return replacement
}

/** Repair legacy MCP cards only when the native completion record proves their status. */
export function repairCodexMcpTools(chatId: string, items: Item[]): boolean {
  const candidates = new Map<string, ToolItem[]>()
  for (const item of items) {
    if (item.kind !== 'tool' || item.tool !== 'shell') continue
    const args = item.args
    if (!args || typeof args !== 'object' || typeof args.server !== 'string' || !args.server
      || typeof args.tool !== 'string' || !args.tool || args.command !== undefined || args.cmd !== undefined) continue
    const key = JSON.stringify([item.callId, args.server, args.tool])
    const matches = candidates.get(key) ?? []
    matches.push(item)
    candidates.set(key, matches)
  }
  if (!candidates.size) return false

  let text: string
  try {
    const file = findCodexRollout(chatId)
    if (!file) return false
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return false
  }

  let changed = false
  for (const { row } of parseRolloutLines(text)) {
    if (row?.type !== 'event_msg' || row.payload?.type !== 'item_completed') continue
    const native = row.payload.item
    if (String(native?.type ?? '').toLowerCase() !== 'mcptoolcall'
      || (native.status !== 'completed' && native.status !== 'failed')) continue
    const key = JSON.stringify([native.id ?? native.callId ?? native.call_id, native.server, native.tool])
    const matches = candidates.get(key)
    if (!matches) continue
    const status = native.status === 'failed' || native.error != null || native.result?.isError === true ? 'error' : 'success'
    for (const item of matches) {
      item.tool = `mcp.${native.server}.${native.tool}`
      item.status = status
      changed = true
    }
  }
  return changed
}
