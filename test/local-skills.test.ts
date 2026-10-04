import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteLocalSkill, readLocalSkill, saveLocalSkill, scanLocalSkills, toggleLocalSkill } from '../src/main/local-skills'
import { hashText, pathKey, type LocalEnv } from '../src/main/local-files'
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
  vi.restoreAllMocks()
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
  it.skipIf(process.platform !== 'linux')('disables and restores same-name skills in case-distinct projects independently', () => {
    const projects = [path.join(root, 'App'), path.join(root, 'app')]
    const dirs = projects.map((dir) => path.join(dir, '.cursor', 'skills', 'same'))
    for (const [index, dir] of dirs.entries()) skill(dir, `---\nname: same\ndescription: Fixture ${index}\n---\nBody ${index}\n`)
    const entries = scanLocalSkills(env, projects).entries
    expect(entries).toHaveLength(2)
    for (const entry of entries) toggleLocalSkill(env, projects, entry.id, false)
    const held = scanLocalSkills(env, projects).entries
    expect(held).toHaveLength(2)
    expect(new Set(held.map((entry) => entry.dir)).size).toBe(2)
    expect(held.every((entry) => !entry.enabled)).toBe(true)
    for (const entry of held) toggleLocalSkill(env, projects, entry.id, true)
    for (const [index, dir] of dirs.entries()) expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain(`Body ${index}`)
  })

  it('restores old disabled skills using the recorded stash path after path-key changes', () => {
    const projectRoot = path.join(root, 'MixedCase', '.cursor', 'skills')
    const legacy = path.join(env.stateDir, 'disabled-skills', hashText(projectRoot.toLowerCase()), 'same')
    skill(legacy, '---\nname: same\ndescription: Legacy fixture\n---\nOriginal body\n')
    fs.writeFileSync(path.join(env.stateDir, 'disabled-skills.json'), JSON.stringify({ entries: [
      { root: projectRoot, rel: 'same', stash: legacy }
    ] }))
    const projects = [path.join(root, 'MixedCase')]
    const entry = scanLocalSkills(env, projects).entries[0]
    expect(entry).toMatchObject({ enabled: false, dir: legacy })
    toggleLocalSkill(env, projects, entry.id, true)
    expect(fs.readFileSync(path.join(projectRoot, 'same', 'SKILL.md'), 'utf8')).toContain('Original body')
    expect(fs.existsSync(legacy)).toBe(false)
  })

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

  it.skipIf(process.platform === 'win32').each(['relative', 'absolute'])('disables and restores a %s skill symlink without changing its target', (kind) => {
    const skills = path.join(env.home, '.agents', 'skills')
    const dir = path.join(skills, 'linked')
    const target = path.join(env.home, '.agents', 'shared-skill')
    const text = '---\nname: linked\ndescription: Shared skill\n---\nOriginal body\n'
    skill(target, text)
    fs.writeFileSync(path.join(target, 'extra.txt'), 'keep')
    fs.mkdirSync(skills, { recursive: true })
    const link = kind === 'relative' ? '../shared-skill' : target
    fs.symlinkSync(link, dir, 'dir')
    const entry = scanLocalSkills(env, []).entries[0]

    for (let i = 0; i < 2; i++) {
      toggleLocalSkill(env, [], entry.id, false)
      expect(fs.lstatSync(dir, { throwIfNoEntry: false })).toBeUndefined()
      const held = scanLocalSkills(env, []).entries[0]
      expect(held).toMatchObject({ id: entry.id, enabled: false, name: 'linked', description: 'Shared skill' })
      expect(fs.lstatSync(held.dir).isSymbolicLink()).toBe(true)
      expect(fs.realpathSync(held.dir)).toBe(target)
      expect(readLocalSkill(env, [], entry.id).body).toBe('Original body\n')
      expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe(text)
      expect(fs.readFileSync(path.join(target, 'extra.txt'), 'utf8')).toBe('keep')
      toggleLocalSkill(env, [], entry.id, true)
      expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true)
      expect(fs.readlinkSync(dir)).toBe(link)
      expect(fs.lstatSync(held.dir, { throwIfNoEntry: false })).toBeUndefined()
      expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe(text)
      expect(fs.readFileSync(path.join(target, 'extra.txt'), 'utf8')).toBe('keep')
    }
  })

  it.skipIf(process.platform === 'win32')('preserves relative resolution through linked skill roots and intermediate links', () => {
    const skills = path.join(env.home, '.agents', 'skills')
    const actualSkills = path.join(root, 'actual-skills')
    const target = path.join(root, 'shared', 'shared-skill')
    skill(target, '---\nname: linked\ndescription: Shared skill\n---\nOriginal body\n')
    fs.mkdirSync(actualSkills, { recursive: true })
    fs.mkdirSync(path.join(root, 'shared', 'nested'), { recursive: true })
    fs.symlinkSync(path.join(root, 'shared', 'nested'), path.join(actualSkills, 'reference'), 'dir')
    fs.mkdirSync(path.dirname(skills), { recursive: true })
    fs.symlinkSync(actualSkills, skills, 'dir')
    const link = 'reference/../shared-skill'
    fs.symlinkSync(link, path.join(skills, 'linked'), 'dir')
    const entry = scanLocalSkills(env, []).entries[0]

    toggleLocalSkill(env, [], entry.id, false)
    const held = scanLocalSkills(env, []).entries[0]
    expect(held).toMatchObject({ name: 'linked', description: 'Shared skill', enabled: false })
    expect(fs.realpathSync.native(held.dir)).toBe(target)
    toggleLocalSkill(env, [], entry.id, true)
    expect(fs.readlinkSync(path.join(skills, 'linked'))).toBe(link)
    expect(fs.realpathSync.native(path.join(skills, 'linked'))).toBe(target)
  })

  it.each([false, true])('moves absolute links and junctions without copying target contents (cross-device: %s)', (crossDevice) => {
    const skills = path.join(env.home, '.agents', 'skills')
    const dir = path.join(skills, 'linked')
    const held = path.join(env.stateDir, 'disabled-skills', hashText(pathKey(skills)), 'linked')
    const target = path.join(root, 'shared-skill')
    const text = '---\nname: linked\ndescription: Shared skill\n---\nOriginal body\n'
    skill(target, text)
    fs.mkdirSync(skills, { recursive: true })
    fs.symlinkSync(target, dir, process.platform === 'win32' ? 'junction' : 'dir')
    const originalLink = fs.readlinkSync(dir)
    const entry = scanLocalSkills(env, []).entries[0]
    if (crossDevice) {
      const rename = fs.renameSync
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (from === dir || from === held) throw Object.assign(new Error('Cross-device move'), { code: 'EXDEV' })
        rename(from, to)
      })
    }
    const symlink = vi.spyOn(fs, 'symlinkSync')
    const copy = vi.spyOn(fs, 'cpSync')

    toggleLocalSkill(env, [], entry.id, false)
    expect(scanLocalSkills(env, []).entries).toMatchObject([{ id: entry.id, enabled: false, description: 'Shared skill' }])
    expect(fs.lstatSync(held).isSymbolicLink()).toBe(true)
    toggleLocalSkill(env, [], entry.id, true)
    expect(fs.readlinkSync(dir)).toBe(originalLink)
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe(text)
    expect(copy).not.toHaveBeenCalled()
    expect(symlink).toHaveBeenCalledTimes(crossDevice ? 2 : 0)
  })

  it.skipIf(process.platform === 'win32')('restores a legacy relative symlink left broken in the stash', () => {
    const skills = path.join(env.home, '.agents', 'skills')
    const target = path.join(env.home, '.agents', 'shared-skill')
    const held = path.join(env.stateDir, 'disabled-skills', hashText(pathKey(skills)), 'linked')
    const text = '---\nname: linked\ndescription: Shared skill\n---\nOriginal body\n'
    skill(target, text)
    fs.writeFileSync(path.join(target, 'extra.txt'), 'keep')
    fs.mkdirSync(path.dirname(held), { recursive: true })
    fs.symlinkSync('../shared-skill', held, 'dir')
    fs.writeFileSync(path.join(env.stateDir, 'disabled-skills.json'), JSON.stringify({ entries: [
      { root: skills, rel: 'linked', stash: held }
    ] }))

    const entry = scanLocalSkills(env, []).entries[0]
    expect(entry).toMatchObject({ name: 'linked', enabled: false, dir: held })
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe(text)
    expect(fs.readlinkSync(held)).toBe('../shared-skill')
    toggleLocalSkill(env, [], entry.id, true)
    expect(fs.readlinkSync(path.join(skills, 'linked'))).toBe('../shared-skill')
    expect(fs.readFileSync(path.join(skills, 'linked', 'SKILL.md'), 'utf8')).toBe(text)
    expect(fs.readFileSync(path.join(target, 'extra.txt'), 'utf8')).toBe('keep')
    expect(fs.lstatSync(held, { throwIfNoEntry: false })).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('keeps a disabled link recoverable if its target disappears', () => {
    const skills = path.join(env.home, '.agents', 'skills')
    const target = path.join(env.home, '.agents', 'shared-skill')
    skill(target, '---\nname: linked\ndescription: Shared skill\n---\n')
    fs.mkdirSync(skills, { recursive: true })
    fs.symlinkSync('../shared-skill', path.join(skills, 'linked'), 'dir')
    const entry = scanLocalSkills(env, []).entries[0]
    toggleLocalSkill(env, [], entry.id, false)
    fs.rmSync(target, { recursive: true })

    expect(scanLocalSkills(env, []).entries).toMatchObject([{ id: entry.id, enabled: false }])
    toggleLocalSkill(env, [], entry.id, true)
    expect(fs.readlinkSync(path.join(skills, 'linked'))).toBe('../shared-skill')
    expect(fs.existsSync(target)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('does not replace dangling links at the stash or restore destination', () => {
    const skills = path.join(env.home, '.agents', 'skills')
    const dir = path.join(skills, 'mine')
    const held = path.join(env.stateDir, 'disabled-skills', hashText(pathKey(skills)), 'mine')
    const target = path.join(env.home, '.agents', 'shared-skill')
    skill(target, '---\nname: mine\ndescription: Mine\n---\nOriginal body\n')
    fs.mkdirSync(skills, { recursive: true })
    fs.symlinkSync('../shared-skill', dir, 'dir')
    fs.mkdirSync(path.dirname(held), { recursive: true })
    fs.symlinkSync('missing-stash-target', held, 'dir')
    const index = path.join(env.stateDir, 'disabled-skills.json')
    fs.writeFileSync(index, '{damaged index')
    const entry = scanLocalSkills(env, []).entries[0]
    expect(() => toggleLocalSkill(env, [], entry.id, false)).toThrow()
    expect(fs.readlinkSync(held)).toBe('missing-stash-target')
    expect(fs.readFileSync(index, 'utf8')).toBe('{damaged index')
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('Original body')

    fs.unlinkSync(held)
    toggleLocalSkill(env, [], entry.id, false)
    fs.symlinkSync('missing-destination-target', dir, 'dir')
    expect(() => toggleLocalSkill(env, [], entry.id, true)).toThrow()
    expect(fs.readlinkSync(dir)).toBe('missing-destination-target')
    expect(fs.readFileSync(path.join(held, 'SKILL.md'), 'utf8')).toContain('Original body')
    expect(scanLocalSkills(env, []).entries).toMatchObject([{ id: entry.id, enabled: false }])
  })

  it.skipIf(process.platform === 'win32')('does not create a same-name skill through an existing dangling link', () => {
    const skills = path.join(env.home, '.agents', 'skills')
    const target = path.join(root, 'missing-skill')
    fs.mkdirSync(skills, { recursive: true })
    fs.symlinkSync(target, path.join(skills, 'mine'), 'dir')
    expect(() => saveLocalSkill(env, [], { target: { cli: 'codex', scope: 'user' }, name: 'mine', description: 'Mine', body: 'Body' })).toThrow()
    expect(fs.readlinkSync(path.join(skills, 'mine'))).toBe(target)
    expect(fs.existsSync(target)).toBe(false)
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
