import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteLocalSkill, readLocalSkill, saveLocalSkill, scanLocalSkills, toggleLocalSkill } from '../src/main/local-skills'
import type { LocalEnv } from '../src/main/local-files'
import { parseSkillMarkdown, updateSkillMarkdown } from '../src/shared/local-config'

let root: string
let env: LocalEnv
let project: string

function skill(dir: string, text: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-local-skills-'))
  env = { home: path.join(root, 'home'), stateDir: path.join(root, 'state') }
  project = path.join(root, 'proj')
  fs.mkdirSync(project, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('skill frontmatter', () => {
  it('reads quoted, plain, and folded values', () => {
    expect(parseSkillMarkdown('---\nname: "a-b"\ndescription: >\n  first\n  second\nlicense: MIT\n---\n\nBody\n')).toMatchObject({ name: 'a-b', description: 'first second', body: 'Body\n' })
    expect(parseSkillMarkdown("---\nname: plain\ndescription: 'it''s'\n---\nx")).toMatchObject({ name: 'plain', description: "it's", body: 'x' })
    expect(parseSkillMarkdown('no frontmatter')).toMatchObject({ frontmatter: null, body: 'no frontmatter' })
  })

  it('keeps other frontmatter keys when updating', () => {
    const next = updateSkillMarkdown('---\nname: old\ndescription: >\n  long\n  text\nlicense: MIT\nmetadata:\n  a: 1\n---\n\nOld body\n', 'new', 'Short', 'New body')
    expect(next).toBe('---\nname: "new"\ndescription: "Short"\nlicense: MIT\nmetadata:\n  a: 1\n---\n\nNew body\n')
  })
})

describe('local skills', () => {
  it('lists user, project, built-in, plugin, and app skills with the right origin', () => {
    skill(path.join(env.home, '.cursor', 'skills', 'mine'), '---\nname: mine\ndescription: Mine\n---\n')
    skill(path.join(env.home, '.cursor', 'skills-cursor', 'shipped'), '---\nname: shipped\ndescription: S\n---\n')
    skill(path.join(env.home, '.codex', 'skills', '.system', 'sys'), '---\nname: sys\ndescription: S\n---\n')
    skill(path.join(env.home, '.codex', 'skills', 'user-codex'), '---\nname: user-codex\ndescription: U\n---\n')
    skill(path.join(env.home, '.cursor', 'plugins', 'cache', 'p', 'v1', 'skills', 'plug'), '---\nname: plug\ndescription: P\n---\n')
    skill(path.join(env.home, '.claude', 'skills', 'managed'), '---\nname: managed\ndescription: M\n---\n')
    fs.writeFileSync(path.join(env.home, '.claude', 'skills', 'managed', 'agent-desktop.json'), '{}')
    skill(path.join(project, '.claude', 'skills', 'proj'), '---\nname: proj\ndescription: P\n---\n')
    const entries = scanLocalSkills(env, [project]).entries
    const by = (name: string) => entries.find((e) => e.name === name)!
    expect(by('mine')).toMatchObject({ cli: 'cursor', origin: 'user', readonly: false, enabled: true })
    expect(by('shipped')).toMatchObject({ cli: 'cursor', origin: 'builtin', readonly: true })
    expect(by('sys')).toMatchObject({ cli: 'codex', origin: 'builtin', readonly: true })
    expect(by('user-codex')).toMatchObject({ cli: 'codex', origin: 'user' })
    expect(by('plug')).toMatchObject({ cli: 'cursor', origin: 'plugin', readonly: true })
    expect(by('managed')).toMatchObject({ cli: 'claude', origin: 'app', readonly: true })
    expect(by('proj')).toMatchObject({ cli: 'claude', origin: 'project', projectPath: project })
    expect(entries.filter((e) => e.name === 'sys')).toHaveLength(1)
  })

  it('creates, edits, renames, and refuses stale edits', () => {
    saveLocalSkill(env, [], { target: { cli: 'codex', scope: 'user' }, name: 'new-one', description: 'D', body: 'Body' })
    const dir = path.join(env.home, '.agents', 'skills', 'new-one')
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('name: "new-one"')
    fs.writeFileSync(path.join(dir, 'extra.txt'), 'keep')
    const entry = scanLocalSkills(env, []).entries[0]
    const content = readLocalSkill(env, [], entry.id)
    expect(content).toMatchObject({ name: 'new-one', description: 'D', body: 'Body\n' })
    expect(() => saveLocalSkill(env, [], { id: entry.id, hash: 'stale', name: 'new-one', description: 'D', body: 'x' })).toThrow()
    saveLocalSkill(env, [], { id: entry.id, hash: content.hash, name: 'renamed', description: 'D2', body: 'B2' })
    const next = path.join(env.home, '.agents', 'skills', 'renamed')
    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.readFileSync(path.join(next, 'extra.txt'), 'utf8')).toBe('keep')
    expect(scanLocalSkills(env, []).entries[0]).toMatchObject({ name: 'renamed', description: 'D2' })
    expect(() => saveLocalSkill(env, [], { target: { cli: 'codex', scope: 'user' }, name: 'renamed', description: 'D', body: '' })).toThrow()
    expect(() => saveLocalSkill(env, [], { target: { cli: 'codex', scope: 'user' }, name: 'Bad Name', description: 'D', body: '' })).toThrow()
  })

  it('disables by moving the folder out and enables by moving it back', () => {
    const dir = path.join(env.home, '.cursor', 'skills', 'mine')
    skill(dir, '---\nname: mine\ndescription: Mine\n---\n')
    const entry = scanLocalSkills(env, []).entries[0]
    toggleLocalSkill(env, [], entry.id, false)
    expect(fs.existsSync(dir)).toBe(false)
    const held = scanLocalSkills(env, []).entries[0]
    expect(held).toMatchObject({ name: 'mine', enabled: false, id: entry.id })
    expect(held.dir.startsWith(env.stateDir)).toBe(true)
    toggleLocalSkill(env, [], held.id, true)
    expect(fs.existsSync(path.join(dir, 'SKILL.md'))).toBe(true)
    expect(scanLocalSkills(env, []).entries).toMatchObject([{ enabled: true }])
  })

  it('moves deleted skills to the trash and never touches read-only ones', async () => {
    skill(path.join(env.home, '.claude', 'skills', 'gone'), '---\nname: gone\ndescription: G\n---\n')
    skill(path.join(env.home, '.cursor', 'skills-cursor', 'shipped'), '---\nname: shipped\ndescription: S\n---\n')
    const entries = scanLocalSkills(env, []).entries
    const trash = vi.fn(async (dir: string) => fs.rmSync(dir, { recursive: true }))
    await deleteLocalSkill(env, [], entries.find((e) => e.name === 'gone')!.id, trash)
    expect(trash).toHaveBeenCalledWith(path.join(env.home, '.claude', 'skills', 'gone'))
    const shipped = entries.find((e) => e.name === 'shipped')!
    await expect(deleteLocalSkill(env, [], shipped.id, trash)).rejects.toThrow()
    expect(() => toggleLocalSkill(env, [], shipped.id, false)).toThrow()
    expect(trash).toHaveBeenCalledTimes(1)
  })
})
