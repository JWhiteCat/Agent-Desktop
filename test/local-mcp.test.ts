import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteLocalMcp, saveLocalMcp, scanLocalMcp, toggleLocalMcp } from '../src/main/local-mcp'
import { parseTomlSections, replaceTomlTables } from '../src/main/toml-lite'
import type { LocalEnv } from '../src/main/local-files'
import type { McpServerConfig } from '../src/shared/types'

let root: string
let env: LocalEnv
let project: string

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

function server(patch: Partial<McpServerConfig>): McpServerConfig {
  return { id: 'x', name: 'x', enabled: true, transport: 'stdio', command: '', args: [], env: [], url: '', headers: [], ...patch }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-local-mcp-'))
  env = { home: path.join(root, 'home'), stateDir: path.join(root, 'state') }
  project = path.join(root, 'proj')
  fs.mkdirSync(env.home, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const CODEX = `# top comment
model = "gpt-5"

[mcp_servers.alpha]
command = "npx"
args = ["-y", "alpha-mcp"]
startup_timeout_sec = 20

[mcp_servers.alpha.env]
TOKEN = "abc"

# keep this comment
[mcp_servers.beta]
url = "https://beta.example/mcp"
enabled = false

[projects.'d:\\work']
trust_level = "trusted"
`

describe('toml-lite', () => {
  it('parses headers, strings, arrays, and inline tables', () => {
    const sections = parseTomlSections(`a = { b = 1, "c d" = 'x' }\n[t."q.k"]\narr = [\n  "1", # c\n  2,\n]\ns = """\nline\\n"""\n`)
    expect(sections[0].values).toEqual({ a: { b: 1, 'c d': 'x' } })
    expect(sections[1].path).toEqual(['t', 'q.k'])
    expect(sections[1].values).toEqual({ arr: ['1', 2], s: 'line\n' })
  })

  it('replaces one server and leaves the rest of the file untouched', () => {
    const next = replaceTomlTables(CODEX, 'mcp_servers', 'alpha', '[mcp_servers.alpha]\ncommand = "uvx"\n')
    expect(next).toContain('# top comment\nmodel = "gpt-5"\n\n[mcp_servers.alpha]\ncommand = "uvx"\n\n# keep this comment\n[mcp_servers.beta]')
    expect(next).not.toContain('TOKEN')
    expect(next).toContain("[projects.'d:\\work']\ntrust_level = \"trusted\"\n")
  })

  it('keeps CRLF line endings', () => {
    const next = replaceTomlTables(CODEX.replace(/\n/g, '\r\n'), 'mcp_servers', 'beta', '')
    expect(next).not.toContain('beta')
    expect(next.replace(/\r\n/g, '')).not.toContain('\n')
  })
})

describe('local MCP configuration', () => {
  it.skipIf(process.platform !== 'linux')('keeps case-distinct project configurations and disabled entries separate', () => {
    const projects = [path.join(root, 'App'), path.join(root, 'app')]
    for (const [index, dir] of projects.entries()) {
      write(path.join(dir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { same: { command: `fixture-${index}` } } }))
    }
    const entries = scanLocalMcp(env, projects).entries
    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.command)).toEqual(['fixture-0', 'fixture-1'])
    toggleLocalMcp(env, projects, entries[0].id, false)
    expect(scanLocalMcp(env, projects).entries.map((entry) => [entry.command, entry.enabled])).toEqual([
      ['fixture-0', false], ['fixture-1', true]
    ])
    toggleLocalMcp(env, projects, entries[0].id, true)
    expect(scanLocalMcp(env, projects).entries.map((entry) => [entry.command, entry.enabled])).toEqual([
      ['fixture-0', true], ['fixture-1', true]
    ])
  })

  it('preserves case-sensitive JSON project keys inside the same Claude file', () => {
    write(path.join(env.home, '.claude.json'), JSON.stringify({
      projects: {
        '/workspace/App': { mcpServers: { same: { command: 'upper' } } },
        '/workspace/app': { mcpServers: { same: { command: 'lower' } } }
      }
    }))
    const entries = scanLocalMcp(env, []).entries
    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.command)).toEqual(['upper', 'lower'])
    toggleLocalMcp(env, [], entries[0].id, false)
    expect(scanLocalMcp(env, []).entries.map((entry) => [entry.command, entry.enabled]).sort()).toEqual([
      ['lower', true], ['upper', false]
    ])
    toggleLocalMcp(env, [], entries[0].id, true)
    expect(scanLocalMcp(env, []).entries.every((entry) => entry.enabled)).toBe(true)
  })

  it('reads Cursor, Codex, and Claude user, local, and project entries', () => {
    write(path.join(env.home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['fs'], env: { A: '1' } } } }))
    write(path.join(env.home, '.codex', 'config.toml'), CODEX)
    write(path.join(env.home, '.claude.json'), JSON.stringify({ userID: 'u', mcpServers: { web: { type: 'sse', url: 'https://w' } }, projects: { 'D:/p': { mcpServers: { loc: { type: 'stdio', command: 'x' } } } } }))
    write(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { type: 'http', url: 'https://s', headers: { H: 'v' } } } }))
    const { entries, errors } = scanLocalMcp(env, [project])
    expect(errors).toEqual([])
    const by = (name: string) => entries.find((e) => e.name === name)!
    expect(by('fs')).toMatchObject({ cli: 'cursor', scope: 'user', transport: 'stdio', command: 'npx', args: ['fs'], env: [{ name: 'A', value: '1' }], enabled: true })
    expect(by('alpha')).toMatchObject({ cli: 'codex', env: [{ name: 'TOKEN', value: 'abc' }], enabled: true })
    expect(by('beta')).toMatchObject({ cli: 'codex', transport: 'http', enabled: false })
    expect(by('web')).toMatchObject({ cli: 'claude', scope: 'user', transport: 'sse' })
    expect(by('loc')).toMatchObject({ cli: 'claude', scope: 'local', projectPath: 'D:/p' })
    expect(by('shared')).toMatchObject({ cli: 'claude', scope: 'project', headers: [{ name: 'H', value: 'v' }] })
  })

  it('edits a Codex server in place, keeping unknown keys and other tables', () => {
    const file = path.join(env.home, '.codex', 'config.toml')
    write(file, CODEX)
    const alpha = scanLocalMcp(env, []).entries.find((e) => e.name === 'alpha')!
    saveLocalMcp(env, [], { id: alpha.id, fileHash: alpha.fileHash, server: { ...alpha, args: ['alpha-mcp@2'], env: [{ name: 'TOKEN', value: 'new' }] } })
    const text = read(file)
    expect(text).toContain('[mcp_servers.alpha]\ncommand = "npx"\nargs = ["alpha-mcp@2"]\nstartup_timeout_sec = 20\n\n[mcp_servers.alpha.env]\nTOKEN = "new"\n')
    expect(text.startsWith('# top comment\n')).toBe(true)
    expect(text).toContain('# keep this comment\n[mcp_servers.beta]')
    expect(fs.existsSync(`${file}.agent-desktop.bak`)).toBe(true)
  })

  it('toggles Codex with the native enabled key', () => {
    const file = path.join(env.home, '.codex', 'config.toml')
    write(file, CODEX)
    const beta = scanLocalMcp(env, []).entries.find((e) => e.name === 'beta')!
    toggleLocalMcp(env, [], beta.id, true, beta.fileHash)
    expect(read(file)).toContain('[mcp_servers.beta]\nurl = "https://beta.example/mcp"\n')
    expect(read(file)).not.toContain('enabled = false')
    expect(scanLocalMcp(env, []).entries.find((e) => e.name === 'beta')!.enabled).toBe(true)
  })

  it('holds a disabled Cursor server outside mcp.json and writes it back when enabled', () => {
    const file = path.join(env.home, '.cursor', 'mcp.json')
    write(file, JSON.stringify({ mcpServers: { fs: { command: 'npx', custom: 1 } }, other: true }))
    const fsEntry = scanLocalMcp(env, []).entries[0]
    toggleLocalMcp(env, [], fsEntry.id, false, fsEntry.fileHash)
    expect(JSON.parse(read(file))).toEqual({ mcpServers: {}, other: true })
    const held = scanLocalMcp(env, []).entries[0]
    expect(held).toMatchObject({ name: 'fs', enabled: false })
    toggleLocalMcp(env, [], held.id, true, held.fileHash)
    expect(JSON.parse(read(file)).mcpServers.fs).toEqual({ command: 'npx', custom: 1 })
    expect(scanLocalMcp(env, []).entries).toHaveLength(1)
  })

  it('adds servers to user and project files and rejects duplicates', () => {
    saveLocalMcp(env, [project], { target: { cli: 'claude', scope: 'user' }, server: server({ name: 'a', command: 'run', args: ['--x'] }) })
    expect(JSON.parse(read(path.join(env.home, '.claude.json'))).mcpServers.a).toEqual({ type: 'stdio', command: 'run', args: ['--x'] })
    saveLocalMcp(env, [project], { target: { cli: 'codex', scope: 'project', projectPath: project }, server: server({ name: 'h', transport: 'http', url: 'https://h', headers: [{ name: 'K', value: 'V' }] }) })
    expect(read(path.join(project, '.codex', 'config.toml'))).toBe('[mcp_servers.h]\nurl = "https://h"\n\n[mcp_servers.h.http_headers]\nK = "V"\n')
    expect(() => saveLocalMcp(env, [project], { target: { cli: 'claude', scope: 'user' }, server: server({ name: 'a', command: 'b' }) })).toThrow(/a/)
    expect(() => saveLocalMcp(env, [], { target: { cli: 'cursor', scope: 'project', projectPath: project }, server: server({ name: 'z', command: 'b' }) })).toThrow()
    expect(() => saveLocalMcp(env, [], { target: { cli: 'codex', scope: 'user' }, server: server({ name: 's', transport: 'sse', url: 'https://s' }) })).toThrow()
  })

  it('refuses to write when the file changed after listing', () => {
    const file = path.join(env.home, '.cursor', 'mcp.json')
    write(file, JSON.stringify({ mcpServers: { fs: { command: 'npx' } } }))
    const entry = scanLocalMcp(env, []).entries[0]
    write(file, JSON.stringify({ mcpServers: { fs: { command: 'npx' }, extra: { command: 'y' } } }))
    expect(() => deleteLocalMcp(env, [], entry.id, entry.fileHash)).toThrow()
    deleteLocalMcp(env, [], entry.id)
    expect(Object.keys(JSON.parse(read(file)).mcpServers)).toEqual(['extra'])
  })

  it('lists inline Codex servers as read-only and reports unreadable files', () => {
    write(path.join(env.home, '.codex', 'config.toml'), '[mcp_servers]\ninline = { command = "x" }\n')
    write(path.join(env.home, '.cursor', 'mcp.json'), '{ broken')
    const { entries, errors } = scanLocalMcp(env, [])
    expect(entries).toMatchObject([{ name: 'inline', readonly: true }])
    expect(errors.map((e) => e.file)).toEqual([path.join(env.home, '.cursor', 'mcp.json')])
    expect(() => toggleLocalMcp(env, [], entries[0].id, false)).toThrow()
  })
})
