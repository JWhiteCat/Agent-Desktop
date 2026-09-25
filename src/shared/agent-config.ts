import type { McpServerConfig, McpTransport, NamedValue, SkillConfig } from './types'

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

const MAX_SKILL_BODY = 100_000
const MAX_TEXT = 4_000

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name) && !WINDOWS_DEVICE.test(name)
}

export function normalizeMcpServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return []
  const out: McpServerConfig[] = []
  const names = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Partial<McpServerConfig>
    const name = clip(row.name, 128)
    if (!name || names.has(name)) continue
    names.add(name)
    const transport: McpTransport = row.transport === 'http' || row.transport === 'sse' ? row.transport : 'stdio'
    out.push({
      id: clip(row.id, 80) || name,
      name,
      enabled: row.enabled !== false,
      transport,
      command: clip(row.command, MAX_TEXT),
      args: stringList(row.args),
      env: pairList(row.env),
      url: clip(row.url, MAX_TEXT),
      headers: pairList(row.headers)
    })
  }
  return out
}

export function normalizeSkills(raw: unknown): SkillConfig[] {
  if (!Array.isArray(raw)) return []
  const out: SkillConfig[] = []
  const names = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Partial<SkillConfig>
    const name = clip(row.name, 64)
    if (!name || names.has(name)) continue
    names.add(name)
    out.push({
      id: clip(row.id, 80) || name,
      name,
      description: clip(row.description, MAX_TEXT),
      enabled: row.enabled !== false,
      body: String(row.body ?? '').replace(/\r\n/g, '\n').slice(0, MAX_SKILL_BODY)
    })
  }
  return out
}

/** ACP `session/new` and `session/load` entry. Incomplete or disabled servers are omitted. */
export function toAcpMcpServer(server: McpServerConfig): Record<string, unknown> | undefined {
  if (!server.enabled) return undefined
  const name = server.name.trim()
  if (!name) return undefined
  if (server.transport === 'stdio') {
    const command = server.command.trim()
    if (!command) return undefined
    const entry: Record<string, unknown> = { name, command }
    const args = server.args.map((arg) => arg.trim()).filter(Boolean)
    if (args.length) entry.args = args
    const env = pairsToObject(server.env)
    if (env) entry.env = env
    return entry
  }
  const url = server.url.trim()
  if (!url) return undefined
  const entry: Record<string, unknown> = { name, type: server.transport, url }
  const headers = pairsToObject(server.headers)
  if (headers) entry.headers = headers
  return entry
}

export function toAcpMcpServers(servers: McpServerConfig[] | undefined): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const server of servers ?? []) {
    const entry = toAcpMcpServer(server)
    if (!entry) continue
    const name = String(entry.name)
    if (seen.has(name)) continue
    seen.add(name)
    out.push(entry)
  }
  return out
}

export function mcpServerReady(server: McpServerConfig): boolean {
  return !!toAcpMcpServer({ ...server, enabled: true })
}

export function skillReady(skill: SkillConfig): boolean {
  return isValidSkillName(skill.name.trim()) && !!skill.description.trim()
}

/** Skills that are written to disk and should invalidate a warm CLI process when they change. */
export function enabledSkillFingerprint(skills: SkillConfig[] | undefined): string[][] {
  return (skills ?? []).filter(skillReady).filter((skill) => skill.enabled).map((skill) => [skill.name.trim(), skill.description.trim(), skill.body])
}

export function renderSkillMarkdown(skill: SkillConfig): string {
  const body = skill.body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '')
  return `---\nname: ${JSON.stringify(skill.name.trim())}\ndescription: ${JSON.stringify(skill.description.trim())}\n---\n\n${body}\n`
}

function pairsToObject(pairs: NamedValue[]): Record<string, string> | undefined {
  const obj: Record<string, string> = {}
  for (const pair of pairs) {
    const name = pair.name.trim()
    if (!name) continue
    obj[name] = pair.value
  }
  return Object.keys(obj).length ? obj : undefined
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => clip(item, MAX_TEXT)).filter(Boolean)
}

function pairList(raw: unknown): NamedValue[] {
  if (!Array.isArray(raw)) return []
  const out: NamedValue[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Partial<NamedValue>
    const name = clip(row.name, 256)
    if (!name) continue
    out.push({ name, value: clip(row.value, MAX_TEXT) })
  }
  return out
}

function clip(raw: unknown, max: number): string {
  return String(raw ?? '').trim().slice(0, max)
}
