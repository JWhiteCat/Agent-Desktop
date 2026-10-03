import path from 'node:path'
import { t as translate } from '@shared/i18n'
import { normalizeMcpServers } from '@shared/agent-config'
import type { LocalConfigError as ReportError, LocalMcpEntry, LocalMcpReport, LocalMcpSaveRequest, LocalMcpScope, LocalTarget } from '@shared/local-config'
import { isCliProvider, type CliProvider, type McpServerConfig, type McpTransport, type NamedValue } from '@shared/types'
import { assertUnchanged, hashText, LocalConfigError, pathKey, readJson, readText, samePath, writeTextSafely, type LocalEnv } from './local-files'
import { parseTomlSections, renderTomlTable, replaceTomlTables, type TomlTable, type TomlValue } from './toml-lite'

type Raw = Record<string, unknown>

interface RefBase {
  cli: CliProvider
  scope: LocalMcpScope
  projectPath?: string
  file: string
}
/** A JSON file and the key path of its server map. */
interface JsonRef extends RefBase {
  kind: 'json'
  container: string[]
}
interface TomlRef extends RefBase {
  kind: 'toml'
}
type Ref = JsonRef | TomlRef

interface Found {
  entry: LocalMcpEntry
  ref: Ref
  raw: Raw
  /** Cursor and Claude have no off switch, so a disabled server is held in this app's state directory. */
  stashed: boolean
}

interface StashEntry {
  file: string
  container: string[]
  name: string
  raw: Raw
}

const STASH_FILE = 'disabled-mcp.json'

export function userMcpFiles(home: string): Record<CliProvider, string> {
  return {
    cursor: path.join(home, '.cursor', 'mcp.json'),
    codex: path.join(home, '.codex', 'config.toml'),
    claude: path.join(home, '.claude.json')
  }
}

function userRef(env: LocalEnv, cli: CliProvider): Ref {
  const file = userMcpFiles(env.home)[cli]
  return cli === 'codex' ? { kind: 'toml', cli, scope: 'user', file } : { kind: 'json', cli, scope: 'user', file, container: ['mcpServers'] }
}

function projectRef(cli: CliProvider, projectPath: string): Ref {
  if (cli === 'codex') return { kind: 'toml', cli, scope: 'project', projectPath, file: path.join(projectPath, '.codex', 'config.toml') }
  const file = cli === 'cursor' ? path.join(projectPath, '.cursor', 'mcp.json') : path.join(projectPath, '.mcp.json')
  return { kind: 'json', cli, scope: 'project', projectPath, file, container: ['mcpServers'] }
}

function refKey(ref: Ref): string {
  return JSON.stringify([pathKey(ref.file), ref.kind === 'json' ? ref.container : []])
}

function entryId(ref: Ref, name: string): string {
  return JSON.stringify([path.resolve(ref.file), ref.kind === 'json' ? ref.container : [], name])
}

function isObject(value: unknown): value is Raw {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function getPath(doc: unknown, keys: string[]): unknown {
  let node = doc
  for (const key of keys) {
    if (!isObject(node)) return undefined
    node = node[key]
  }
  return node
}

function stashPath(env: LocalEnv): string {
  return path.join(env.stateDir, STASH_FILE)
}

function readStash(env: LocalEnv): StashEntry[] {
  try {
    const data = readJson<{ entries?: StashEntry[] }>(stashPath(env), {})
    return (data.entries ?? []).filter((e) => e && typeof e.file === 'string' && Array.isArray(e.container) && typeof e.name === 'string' && isObject(e.raw))
  } catch {
    return []
  }
}

function writeStash(env: LocalEnv, entries: StashEntry[]): void {
  writeTextSafely(stashPath(env), `${JSON.stringify({ entries }, null, 2)}\n`, false)
}

function stashMatches(entry: StashEntry, ref: Ref, name?: string): boolean {
  return refKey(ref) === JSON.stringify([pathKey(entry.file), entry.container]) && (name === undefined || entry.name === name)
}

function allRefs(env: LocalEnv, projects: string[]): Ref[] {
  const refs: Ref[] = (['cursor', 'codex', 'claude'] as const).map((cli) => userRef(env, cli))
  for (const project of projects) for (const cli of ['cursor', 'codex', 'claude'] as const) refs.push(projectRef(cli, project))
  const claudeFile = userMcpFiles(env.home).claude
  const keys = new Set<string>()
  try {
    const doc = readJson<Raw>(claudeFile, {})
    const byProject = doc.projects
    if (isObject(byProject)) {
      for (const [key, value] of Object.entries(byProject)) if (isObject(value) && isObject(value.mcpServers) && Object.keys(value.mcpServers).length) keys.add(key)
    }
  } catch {
    // Reported when the user-level entries are read.
  }
  for (const stashed of readStash(env)) {
    if (samePath(stashed.file, claudeFile) && stashed.container.length === 3 && stashed.container[0] === 'projects') keys.add(stashed.container[1])
  }
  for (const key of keys) refs.push({ kind: 'json', cli: 'claude', scope: 'local', projectPath: key, file: claudeFile, container: ['projects', key, 'mcpServers'] })
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = refKey(ref)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function pairs(value: unknown): NamedValue[] {
  if (!isObject(value)) return []
  return Object.entries(value).map(([name, v]) => ({ name, value: typeof v === 'string' ? v : JSON.stringify(v) }))
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}

function jsonTransport(raw: Raw): McpTransport {
  const type = String(raw.type ?? '').toLowerCase()
  if (type === 'sse') return 'sse'
  if (type === 'http' || type === 'streamable-http' || type === 'streamablehttp' || typeof raw.url === 'string') return 'http'
  return 'stdio'
}

function toEntry(ref: Ref, name: string, raw: Raw, hash: string, stashed: boolean): LocalMcpEntry {
  const toml = ref.kind === 'toml'
  const transport: McpTransport = toml ? (typeof raw.url === 'string' ? 'http' : 'stdio') : jsonTransport(raw)
  return {
    id: entryId(ref, name),
    name,
    enabled: toml ? raw.enabled !== false : !stashed,
    transport,
    command: typeof raw.command === 'string' ? raw.command : '',
    args: strings(raw.args),
    env: pairs(raw.env),
    url: typeof raw.url === 'string' ? raw.url : '',
    headers: pairs(toml ? raw.http_headers : raw.headers),
    cli: ref.cli,
    scope: ref.scope,
    ...(ref.projectPath ? { projectPath: ref.projectPath } : {}),
    file: ref.file,
    fileHash: hash
  }
}

function tomlServers(text: string): { tables: Map<string, TomlTable>; inline: Map<string, TomlTable>; error?: string } {
  const sections = parseTomlSections(text)
  const tables = new Map<string, TomlTable>()
  const inline = new Map<string, TomlTable>()
  let error: string | undefined
  for (const section of sections) {
    if (section.error && (section.path[0] === 'mcp_servers' || section.path.length === 0)) error ??= section.error
    if (section.array) continue
    if (section.path.length === 0) {
      const map = section.values.mcp_servers
      if (map && typeof map === 'object' && !Array.isArray(map)) for (const [k, v] of Object.entries(map)) if (isObject(v)) inline.set(k, v as TomlTable)
      continue
    }
    if (section.path[0] !== 'mcp_servers') continue
    if (section.path.length === 1) {
      for (const [k, v] of Object.entries(section.values)) if (isObject(v)) inline.set(k, v as TomlTable)
      continue
    }
    const name = section.path[1]
    const table = tables.get(name) ?? {}
    let node: TomlTable = table
    for (const key of section.path.slice(2)) {
      const next = node[key]
      node = isObject(next) ? (next as TomlTable) : (node[key] = {})
    }
    Object.assign(node, section.values)
    tables.set(name, table)
  }
  return { tables, inline, error }
}

function collect(env: LocalEnv, projects: string[]): { found: Found[]; errors: ReportError[] } {
  const found: Found[] = []
  const errors: ReportError[] = []
  const stash = readStash(env)
  const reported = new Set<string>()
  const report = (file: string, message: string) => {
    if (reported.has(file)) return
    reported.add(file)
    errors.push({ file, message })
  }
  for (const ref of allRefs(env, projects)) {
    const text = readText(ref.file)
    const hash = hashText(text ?? '')
    if (ref.kind === 'toml') {
      if (text === undefined) continue
      const { tables, inline, error } = tomlServers(text)
      if (error) report(ref.file, error)
      for (const [name, raw] of tables) found.push({ entry: toEntry(ref, name, raw, hash, false), ref, raw, stashed: false })
      for (const [name, raw] of inline) {
        if (tables.has(name)) continue
        const entry = { ...toEntry(ref, name, raw, hash, false), readonly: true, note: translate('写在 [mcp_servers] 的内联表里，请直接编辑文件') }
        found.push({ entry, ref, raw, stashed: false })
      }
      continue
    }
    let names = new Set<string>()
    if (text !== undefined && text.trim()) {
      try {
        const container = getPath(JSON.parse(text.replace(/^\uFEFF/, '')), ref.container)
        if (isObject(container)) {
          for (const [name, raw] of Object.entries(container)) {
            if (!isObject(raw)) continue
            found.push({ entry: toEntry(ref, name, raw, hash, false), ref, raw, stashed: false })
          }
          names = new Set(Object.keys(container))
        }
      } catch (err) {
        report(ref.file, err instanceof Error ? err.message : String(err))
        continue
      }
    }
    for (const item of stash) {
      if (!stashMatches(item, ref) || names.has(item.name)) continue
      found.push({ entry: toEntry(ref, item.name, item.raw, hash, true), ref, raw: item.raw, stashed: true })
    }
  }
  return { found, errors }
}

export function scanLocalMcp(env: LocalEnv, projects: string[]): LocalMcpReport {
  const { found, errors } = collect(env, projects)
  return { entries: found.map((f) => f.entry), errors }
}

function find(env: LocalEnv, projects: string[], id: string): Found {
  const hit = collect(env, projects).found.find((f) => f.entry.id === id)
  if (!hit) throw new LocalConfigError(translate('找不到这个条目，请刷新后再试'))
  if (hit.entry.readonly) throw new LocalConfigError(hit.entry.note ?? translate('这个条目是只读的'))
  return hit
}

function targetRef(env: LocalEnv, projects: string[], target: LocalTarget | undefined): Ref {
  if (!target || !isCliProvider(target.cli)) throw new LocalConfigError(translate('请选择 CLI'))
  if (target.scope === 'user') return userRef(env, target.cli)
  const project = projects.find((p) => target.projectPath && samePath(p, target.projectPath))
  if (target.scope !== 'project' || !project) throw new LocalConfigError(translate('请选择一个已添加的项目'))
  return projectRef(target.cli, project)
}

function objectOf(list: NamedValue[]): Raw | undefined {
  const out: Raw = {}
  for (const pair of list) if (pair.name.trim()) out[pair.name.trim()] = pair.value
  return Object.keys(out).length ? out : undefined
}

const JSON_KNOWN = ['type', 'command', 'args', 'env', 'url', 'headers']
const TOML_KNOWN = ['command', 'args', 'env', 'url', 'http_headers', 'enabled']
const TOML_STDIO_ONLY = ['cwd', 'env_vars']
const TOML_HTTP_ONLY = ['bearer_token_env_var', 'env_http_headers']

function withoutKeys(raw: Raw, keys: string[]): Raw {
  const out: Raw = {}
  for (const [k, v] of Object.entries(raw)) if (!keys.includes(k)) out[k] = v
  return out
}

function buildRaw(ref: Ref, prev: Raw, server: McpServerConfig): Raw {
  const args = server.args.length ? { args: server.args } : {}
  const env = objectOf(server.env)
  const headers = objectOf(server.headers)
  if (ref.kind === 'toml') {
    if (server.transport === 'sse') throw new LocalConfigError(translate('Codex 只支持 stdio 和 HTTP 传输'))
    if (server.transport === 'stdio') {
      const rest = withoutKeys(prev, [...TOML_KNOWN, ...TOML_HTTP_ONLY])
      return { command: server.command, ...args, ...rest, ...(env ? { env } : {}) }
    }
    const rest = withoutKeys(prev, [...TOML_KNOWN, ...TOML_STDIO_ONLY])
    return { url: server.url, ...rest, ...(headers ? { http_headers: headers } : {}) }
  }
  const rest = withoutKeys(prev, JSON_KNOWN)
  if (server.transport === 'stdio') {
    const type = ref.cli === 'claude' || prev.type !== undefined ? { type: 'stdio' } : {}
    return { ...type, command: server.command, ...args, ...(env ? { env } : {}), ...rest }
  }
  const type = ref.cli === 'claude' || server.transport === 'sse' || prev.type !== undefined ? { type: server.transport } : {}
  return { ...type, url: server.url, ...(headers ? { headers } : {}), ...rest }
}

function jsonText(original: string | undefined, doc: unknown): string {
  const indent = original && /\n\t/.test(original) ? '\t' : 2
  const text = `${JSON.stringify(doc, null, indent)}\n`
  return original?.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text
}

function readDoc(ref: JsonRef): { original: string | undefined; doc: Raw } {
  const original = readText(ref.file)
  if (original === undefined || !original.trim()) return { original, doc: {} }
  const doc = JSON.parse(original.replace(/^\uFEFF/, '')) as unknown
  if (!isObject(doc)) throw new LocalConfigError(translate('{path} 不是 JSON 对象', { path: ref.file }))
  return { original, doc }
}

function ensureContainer(doc: Raw, keys: string[]): Raw {
  let node = doc
  for (const key of keys) {
    if (!isObject(node[key])) node[key] = {}
    node = node[key] as Raw
  }
  return node
}

function duplicate(name: string): LocalConfigError {
  return new LocalConfigError(translate('这个配置里已经有名为「{name}」的 MCP 服务器', { name }))
}

/** Removes `old` (if any) and writes `name` in its place, enabled or not. */
function writeServer(env: LocalEnv, ref: Ref, old: Found | undefined, name: string, raw: Raw, enabled: boolean): void {
  if (ref.kind === 'toml') {
    const text = readText(ref.file) ?? ''
    const { tables, inline } = tomlServers(text)
    if (name !== old?.entry.name && (tables.has(name) || inline.has(name))) throw duplicate(name)
    const table = withoutKeys(raw, ['enabled']) as TomlTable
    const block = renderTomlTable(['mcp_servers', name], enabled ? table : { ...table, enabled: false as TomlValue })
    const last = [...tables.keys()].pop()
    writeTextSafely(ref.file, replaceTomlTables(text, 'mcp_servers', old?.entry.name ?? name, block, last))
    return
  }
  const { original, doc } = readDoc(ref)
  const container = ensureContainer(doc, ref.container)
  let stash = readStash(env)
  const stashBefore = stash.length
  let nativeChanged = false
  if (old) {
    if (old.stashed) stash = stash.filter((item) => !stashMatches(item, ref, old.entry.name))
    else {
      delete container[old.entry.name]
      nativeChanged = true
    }
  }
  if (Object.hasOwn(container, name) || stash.some((item) => stashMatches(item, ref, name))) throw duplicate(name)
  if (enabled) {
    container[name] = raw
    nativeChanged = true
  } else {
    stash.push({ file: path.resolve(ref.file), container: ref.container, name, raw })
  }
  if (nativeChanged) writeTextSafely(ref.file, jsonText(original, doc))
  if (stash.length !== stashBefore || old?.stashed || !enabled) writeStash(env, stash)
}

export function saveLocalMcp(env: LocalEnv, projects: string[], req: LocalMcpSaveRequest): void {
  const server = normalizeMcpServers([req.server])[0]
  if (!server) throw new LocalConfigError(translate('请填写名称'))
  if (server.transport === 'stdio' ? !server.command : !server.url) {
    throw new LocalConfigError(server.transport === 'stdio' ? translate('请填写命令') : translate('请填写地址'))
  }
  if (req.id) {
    const old = find(env, projects, req.id)
    assertUnchanged(old.ref.file, req.fileHash)
    writeServer(env, old.ref, old, server.name, buildRaw(old.ref, old.raw, server), server.enabled)
    return
  }
  const ref = targetRef(env, projects, req.target)
  writeServer(env, ref, undefined, server.name, buildRaw(ref, {}, server), server.enabled)
}

export function toggleLocalMcp(env: LocalEnv, projects: string[], id: string, enabled: boolean, hash?: string): void {
  const old = find(env, projects, id)
  assertUnchanged(old.ref.file, hash)
  if (old.entry.enabled === enabled) return
  writeServer(env, old.ref, old, old.entry.name, old.raw, enabled)
}

export function deleteLocalMcp(env: LocalEnv, projects: string[], id: string, hash?: string): void {
  const old = find(env, projects, id)
  assertUnchanged(old.ref.file, hash)
  const ref = old.ref
  if (ref.kind === 'toml') {
    writeTextSafely(ref.file, replaceTomlTables(readText(ref.file) ?? '', 'mcp_servers', old.entry.name, ''))
    return
  }
  if (old.stashed) {
    writeStash(env, readStash(env).filter((item) => !stashMatches(item, ref, old.entry.name)))
    return
  }
  const { original, doc } = readDoc(ref)
  const container = getPath(doc, ref.container)
  if (isObject(container)) delete container[old.entry.name]
  writeTextSafely(ref.file, jsonText(original, doc))
}
