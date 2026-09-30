import type { CliProvider, McpServerConfig } from './types'

/** `user` is the CLI's home config, `local` is Claude's per-project entry in ~/.claude.json, `project` is a file inside the project. */
export type LocalMcpScope = 'user' | 'local' | 'project'

/** One MCP server read from a CLI's own configuration file. */
export interface LocalMcpEntry extends McpServerConfig {
  cli: CliProvider
  scope: LocalMcpScope
  projectPath?: string
  file: string
  /** Hash of the file when it was listed. Writes are refused when the file has changed since. */
  fileHash: string
  /** Entries this app cannot rewrite safely, such as Codex servers defined inline under `[mcp_servers]`. */
  readonly?: boolean
  note?: string
}

export interface LocalConfigError {
  file: string
  message: string
}

export interface LocalMcpReport {
  entries: LocalMcpEntry[]
  errors: LocalConfigError[]
}

/** Where a new entry is written. `projectPath` must be one of the app's projects. */
export interface LocalTarget {
  cli: CliProvider
  scope: 'user' | 'project'
  projectPath?: string
}

export interface LocalMcpSaveRequest {
  /** Existing entry. Omitted for a new one, which uses `target`. */
  id?: string
  target?: LocalTarget
  fileHash?: string
  server: McpServerConfig
}

/** `builtin` and `plugin` are shipped and overwritten by the CLI. `app` directories are written by this app's Skill list. */
export type LocalSkillOrigin = 'user' | 'project' | 'builtin' | 'plugin' | 'app'

export interface LocalSkillEntry {
  id: string
  cli: CliProvider
  origin: LocalSkillOrigin
  projectPath?: string
  name: string
  description: string
  enabled: boolean
  readonly: boolean
  /** Current directory. A disabled skill lives in this app's holding directory. */
  dir: string
  /** Skills directory the entry belongs to. */
  root: string
}

export interface LocalSkillReport {
  entries: LocalSkillEntry[]
  errors: LocalConfigError[]
}

export interface LocalSkillContent {
  name: string
  description: string
  body: string
  hash: string
}

export interface LocalSkillSaveRequest {
  id?: string
  target?: LocalTarget
  hash?: string
  name: string
  description: string
  body: string
}

export interface ParsedSkillMarkdown {
  name?: string
  description?: string
  body: string
  /** Frontmatter lines without the `---` fences, or null when the file has none. */
  frontmatter: string[] | null
}

const FENCE = /^---\s*$/

export function parseSkillMarkdown(text: string): ParsedSkillMarkdown {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const lines = src.split('\n')
  if (!FENCE.test(lines[0] ?? '')) return { body: src, frontmatter: null }
  const close = lines.findIndex((line, i) => i > 0 && FENCE.test(line))
  if (close < 0) return { body: src, frontmatter: null }
  const frontmatter = lines.slice(1, close)
  const body = lines.slice(close + 1).join('\n').replace(/^\n+/, '')
  return { name: frontmatterValue(frontmatter, 'name'), description: frontmatterValue(frontmatter, 'description'), body, frontmatter }
}

/** Rewrites name, description, and body. Other frontmatter keys are kept as written. */
export function updateSkillMarkdown(original: string, name: string, description: string, body: string): string {
  const parsed = parseSkillMarkdown(original)
  const kept = parsed.frontmatter ? dropKeys(parsed.frontmatter, ['name', 'description']) : []
  const head = [`name: ${JSON.stringify(name.trim())}`, `description: ${JSON.stringify(description.trim())}`, ...kept]
  const text = body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '')
  return `---\n${head.join('\n')}\n---\n\n${text}\n`
}

function keyOf(line: string): string | undefined {
  return /^([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1]
}

/** Lines of one top-level key: the key line plus indented or blank continuation lines. */
function keySpan(lines: string[], start: number): number {
  let end = start + 1
  while (end < lines.length && (/^\s+\S/.test(lines[end]) || (lines[end].trim() === '' && end + 1 < lines.length && /^\s+\S/.test(lines[end + 1])))) end++
  return end
}

function dropKeys(lines: string[], keys: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; ) {
    const key = keyOf(lines[i])
    if (key && keys.includes(key)) {
      i = keySpan(lines, i)
      continue
    }
    out.push(lines[i])
    i++
  }
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out
}

function frontmatterValue(lines: string[], key: string): string | undefined {
  const index = lines.findIndex((line) => keyOf(line) === key)
  if (index < 0) return undefined
  const raw = lines[index].slice(lines[index].indexOf(':') + 1).trim()
  const rest = lines.slice(index + 1, keySpan(lines, index)).map((line) => line.trim())
  if (/^[>|][+-]?$/.test(raw)) return rest.join(raw.startsWith('>') ? ' ' : '\n').trim()
  const value = [raw, ...rest].filter(Boolean).join(' ')
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value))
    } catch {
      return value.replace(/^"|"$/g, '')
    }
  }
  if (value.startsWith("'")) return value.replace(/^'|'$/g, '').replace(/''/g, "'")
  return value
}
