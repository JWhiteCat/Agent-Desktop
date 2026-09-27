export interface SlashCommand {
  name: string
  description: string
  /** Shown after the command is chosen, while its argument is still empty. */
  hint?: string
  /** Handled by this app. A CLI command with the same name is not shown. */
  local?: boolean
}

export const FORK_COMMAND: SlashCommand = {
  name: 'fork',
  description: '从当前对话分叉，原对话保持不变',
  local: true
}

/** Reads an ACP `availableCommands` array. Unknown input types keep the command and drop the hint. */
export function parseAvailableCommands(raw: unknown): SlashCommand[] {
  if (!Array.isArray(raw)) return []
  const out: SlashCommand[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    const description = typeof rec.description === 'string' ? rec.description.trim() : ''
    if (!name || !description || seen.has(name)) continue
    seen.add(name)
    const hint = commandHint(rec.input)
    out.push(hint ? { name, description, hint } : { name, description })
  }
  return out
}

function commandHint(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const rec = input as Record<string, unknown>
  if (typeof rec.type === 'string' && rec.type !== 'text') return undefined
  const hint = typeof rec.hint === 'string' ? rec.hint.trim() : ''
  return hint || undefined
}

/**
 * Text after `/` while a command name is being typed.
 * A space means arguments have started, so the menu stays closed.
 */
export function slashQuery(text: string): string | undefined {
  if (/[\r\n]/.test(text)) return undefined
  const body = text.trimStart()
  if (!body.startsWith('/')) return undefined
  const name = body.slice(1)
  if (/\s/.test(name)) return undefined
  return name
}

export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  return commands.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
}

/** Local commands win when a CLI command uses the same name. */
export function mergeCommands(local: SlashCommand[], remote: SlashCommand[]): SlashCommand[] {
  const names = new Set(local.map((c) => c.name))
  return [...local, ...remote.filter((c) => !names.has(c.name))]
}

/** Keeps CLI commands. Drops local commands and broken entries. */
export function sanitizeSlashCommands(raw: unknown): SlashCommand[] {
  if (!Array.isArray(raw)) return []
  const out: SlashCommand[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (rec.local === true) continue
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    const description = typeof rec.description === 'string' ? rec.description.trim() : ''
    if (!name || !description || seen.has(name)) continue
    seen.add(name)
    const hint = typeof rec.hint === 'string' ? rec.hint.trim() : ''
    out.push(hint ? { name, description, hint } : { name, description })
  }
  return out
}

export interface CommandCache {
  cursor?: SlashCommand[]
  codex?: SlashCommand[]
}

/** Reads a persisted per-CLI command cache. An empty list is kept. */
export function sanitizeCommandCache(raw: unknown): CommandCache {
  if (!raw || typeof raw !== 'object') return {}
  const rec = raw as Record<string, unknown>
  const out: CommandCache = {}
  for (const cli of ['cursor', 'codex'] as const) {
    if (!(cli in rec)) continue
    out[cli] = sanitizeSlashCommands(rec[cli])
  }
  return out
}

/** Hint for a draft that is exactly `/name ` and that command takes input. */
export function argumentHint(text: string, commands: SlashCommand[]): string | undefined {
  const match = /^\/(\S+) $/.exec(text)
  if (!match) return undefined
  return commands.find((c) => c.name === match[1])?.hint
}
