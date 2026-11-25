import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanLocalMcp, saveLocalMcp } from '../src/main/local-mcp'
import { parseTomlSections, replaceTomlTables } from '../src/main/toml-lite'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('toml-lite UTF-8 BOM handling (#32)', () => {
  it('strips leading UTF-8 BOM when parsing section headers on line 1', () => {
    const src = '\uFEFF[mcp_servers.alpha]\ncommand = "npx"\nargs = ["-y", "alpha"]\n\n[mcp_servers.beta]\nurl = "https://beta.example"\n'
    const sections = parseTomlSections(src)
    expect(sections.every((s) => !s.error)).toBe(true)
    expect(sections[1].path).toEqual(['mcp_servers', 'alpha'])
    expect(sections[1].values).toEqual({ command: 'npx', args: ['-y', 'alpha'] })
    expect(sections[2].path).toEqual(['mcp_servers', 'beta'])
    expect(sections[2].values).toEqual({ url: 'https://beta.example' })
  })

  it('strips leading UTF-8 BOM before root keys, comments, and empty files', () => {
    const rootKey = parseTomlSections('\uFEFFmodel = "gpt-5"\n[mcp_servers.a]\ncommand = "x"\n')
    expect(rootKey.every((s) => !s.error)).toBe(true)
    expect(rootKey[0].values).toEqual({ model: 'gpt-5' })
    expect(rootKey[1].path).toEqual(['mcp_servers', 'a'])

    const comment = parseTomlSections('\uFEFF# header comment\n[mcp_servers.a]\ncommand = "x"\n')
    expect(comment.every((s) => !s.error)).toBe(true)
    expect(comment[1].path).toEqual(['mcp_servers', 'a'])

    const bomOnly = parseTomlSections('\uFEFF')
    expect(bomOnly).toHaveLength(1)
    expect(bomOnly[0].error).toBeUndefined()
  })

  it('replaces tables cleanly in BOM-prefixed TOML without off-by-one corruption', () => {
    const src = '\uFEFF[mcp_servers.alpha]\ncommand = "npx"\n\n[mcp_servers.beta]\ncommand = "uvx"\n'
    const replacedAlpha = replaceTomlTables(src, 'mcp_servers', 'alpha', '[mcp_servers.alpha]\ncommand = "node"\n')
    expect(replacedAlpha).toBe('[mcp_servers.alpha]\ncommand = "node"\n\n[mcp_servers.beta]\ncommand = "uvx"\n')

    const replacedBeta = replaceTomlTables(src, 'mcp_servers', 'beta', '[mcp_servers.beta]\ncommand = "bun"\n')
    expect(replacedBeta).toBe('[mcp_servers.alpha]\ncommand = "npx"\n\n[mcp_servers.beta]\ncommand = "bun"\n')
  })

  it('scans and edits a BOM-prefixed Codex config.toml without parse errors', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-toml-bom-'))
    tempDirs.push(root)
    const home = path.join(root, 'home')
    const stateDir = path.join(root, 'state')
    const file = path.join(home, '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '\uFEFF[mcp_servers.alpha]\ncommand = "npx"\nargs = ["-y", "alpha"]\n', 'utf8')

    const scan = scanLocalMcp({ home, stateDir }, [])
    expect(scan.errors).toEqual([])
    expect(scan.entries).toHaveLength(1)
    expect(scan.entries[0]).toMatchObject({ cli: 'codex', name: 'alpha', command: 'npx', args: ['-y', 'alpha'] })

    const entry = scan.entries[0]
    saveLocalMcp({ home, stateDir }, [], {
      id: entry.id,
      fileHash: entry.fileHash,
      server: { ...entry, args: ['-y', 'alpha@2'] }
    })
    const updated = scanLocalMcp({ home, stateDir }, [])
    expect(updated.errors).toEqual([])
    expect(updated.entries[0].args).toEqual(['-y', 'alpha@2'])
  })
})
