import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isValidSkillName, normalizeMcpServers, normalizeSkills, renderSkillMarkdown, toAcpMcpServers } from '../src/shared/agent-config'
import { syncManagedSkills } from '../src/main/skills'
import type { McpServerConfig, SkillConfig } from '../src/shared/types'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function skill(patch: Partial<SkillConfig> = {}): SkillConfig {
  return {
    id: 's1',
    name: 'review-diff',
    description: 'Review a diff',
    enabled: true,
    body: 'Look at the patch.',
    ...patch
  }
}

function server(patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'm1',
    name: 'files',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'server'],
    env: [{ name: 'TOKEN', value: 'secret' }],
    url: '',
    headers: [],
    ...patch
  }
}

describe('mcp and skill config', () => {
  it('builds ACP servers and skips disabled or incomplete ones', () => {
    expect(
      toAcpMcpServers([
        server(),
        server({ id: 'off', name: 'off', enabled: false }),
        server({ id: 'empty', name: 'empty', command: '  ' }),
        server({
          id: 'remote',
          name: 'remote',
          transport: 'http',
          url: 'https://example.com/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer t' }]
        })
      ])
    ).toEqual([
      { name: 'files', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'secret' } },
      { name: 'remote', type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } }
    ])
  })

  it('drops invalid and duplicate entries while loading settings', () => {
    expect(normalizeMcpServers([{ name: 'a', command: 'cmd' }, { name: 'a', command: 'other' }, null, { name: '  ' }])).toEqual([
      { id: 'a', name: 'a', enabled: true, transport: 'stdio', command: 'cmd', args: [], env: [], url: '', headers: [] }
    ])
    expect(normalizeSkills([{ name: 'Demo', description: 'x', body: 'y' }, { name: 'Demo' }])).toEqual([
      { id: 'Demo', name: 'Demo', enabled: true, description: 'x', body: 'y' }
    ])
    expect(isValidSkillName('review-diff')).toBe(true)
    expect(isValidSkillName('Demo')).toBe(false)
    expect(isValidSkillName('con')).toBe(false)
  })

  it('renders skill frontmatter', () => {
    expect(renderSkillMarkdown(skill({ description: 'say "hi"' }))).toBe('---\nname: "review-diff"\ndescription: "say \\"hi\\""\n---\n\nLook at the patch.\n')
  })

  it('writes managed skills and leaves foreign directories alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-skills-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, 'foreign'))
    fs.writeFileSync(path.join(root, 'foreign', 'keep.txt'), 'stay')

    syncManagedSkills([skill(), skill({ id: 'bad', name: 'Not Valid', description: 'x' })], root)
    expect(fs.readFileSync(path.join(root, 'review-diff', 'SKILL.md'), 'utf8')).toContain('Look at the patch.')
    expect(fs.existsSync(path.join(root, 'review-diff', 'agent-desktop.json'))).toBe(true)
    expect(fs.readFileSync(path.join(root, 'foreign', 'keep.txt'), 'utf8')).toBe('stay')

    expect(() => syncManagedSkills([skill({ name: 'foreign', description: 'taken' })], root)).toThrow(/不是本应用创建的/)
    expect(fs.readFileSync(path.join(root, 'foreign', 'keep.txt'), 'utf8')).toBe('stay')

    syncManagedSkills([skill({ enabled: false })], root)
    expect(fs.existsSync(path.join(root, 'review-diff'))).toBe(false)
  })
})
