import fs from 'node:fs'
import path from 'node:path'
import { t as translate } from '@shared/i18n'
import { isValidSkillName, renderSkillMarkdown } from '@shared/agent-config'
import {
  parseSkillMarkdown,
  updateSkillMarkdown,
  type LocalConfigError as ReportError,
  type LocalSkillContent,
  type LocalSkillEntry,
  type LocalSkillReport,
  type LocalSkillSaveRequest,
  type LocalTarget
} from '@shared/local-config'
import { isCliProvider, type CliProvider } from '@shared/types'
import { assertUnchanged, hashText, LocalConfigError, moveDir, pathKey, readJson, readText, samePath, writeTextSafely, type LocalEnv } from './local-files'

const MARKER = 'agent-desktop.json'
const SKILL_FILE = 'SKILL.md'
const STASH_INDEX = 'disabled-skills.json'
const STASH_DIR = 'disabled-skills'
const MAX_WALK_DEPTH = 8
const MAX_WALK_ENTRIES = 1000

interface SkillRoot {
  cli: CliProvider
  origin: 'user' | 'project' | 'builtin' | 'plugin'
  dir: string
  projectPath?: string
  /** Plugin caches nest skills at varying depths. */
  walk?: boolean
  skip?: string[]
}

interface StashEntry {
  root: string
  rel: string
  stash: string
}

interface Found {
  entry: LocalSkillEntry
  root: SkillRoot
  rel: string
  stashed: boolean
}

export function skillRoots(env: LocalEnv, projects: string[]): SkillRoot[] {
  const h = env.home
  const roots: SkillRoot[] = [
    { cli: 'cursor', origin: 'user', dir: path.join(h, '.cursor', 'skills') },
    { cli: 'codex', origin: 'user', dir: path.join(h, '.agents', 'skills') },
    { cli: 'codex', origin: 'user', dir: path.join(h, '.codex', 'skills'), skip: ['.system'] },
    { cli: 'claude', origin: 'user', dir: path.join(h, '.claude', 'skills') },
    { cli: 'cursor', origin: 'builtin', dir: path.join(h, '.cursor', 'skills-cursor') },
    { cli: 'codex', origin: 'builtin', dir: path.join(h, '.codex', 'skills', '.system') },
    { cli: 'cursor', origin: 'plugin', dir: path.join(h, '.cursor', 'plugins'), walk: true },
    { cli: 'codex', origin: 'plugin', dir: path.join(h, '.codex', 'plugins'), walk: true },
    { cli: 'claude', origin: 'plugin', dir: path.join(h, '.claude', 'plugins'), walk: true }
  ]
  for (const p of projects) {
    roots.push(
      { cli: 'cursor', origin: 'project', projectPath: p, dir: path.join(p, '.cursor', 'skills') },
      { cli: 'codex', origin: 'project', projectPath: p, dir: path.join(p, '.agents', 'skills') },
      { cli: 'codex', origin: 'project', projectPath: p, dir: path.join(p, '.codex', 'skills'), skip: ['.system'] },
      { cli: 'claude', origin: 'project', projectPath: p, dir: path.join(p, '.claude', 'skills') }
    )
  }
  const seen: SkillRoot[] = []
  return roots.filter((root) => {
    if (seen.some((other) => samePath(other.dir, root.dir))) return false
    seen.push(root)
    return true
  })
}

function targetRoot(env: LocalEnv, projects: string[], target: LocalTarget | undefined): SkillRoot {
  if (!target || !isCliProvider(target.cli)) throw new LocalConfigError(translate('请选择 CLI'))
  const sub = target.cli === 'cursor' ? '.cursor' : target.cli === 'codex' ? '.agents' : '.claude'
  if (target.scope === 'user') return { cli: target.cli, origin: 'user', dir: path.join(env.home, sub, 'skills') }
  const project = projects.find((p) => target.projectPath && samePath(p, target.projectPath))
  if (target.scope !== 'project' || !project) throw new LocalConfigError(translate('请选择一个已添加的项目'))
  return { cli: target.cli, origin: 'project', projectPath: project, dir: path.join(project, sub, 'skills') }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function childSkillDirs(root: SkillRoot): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(root.dir)
  } catch {
    return []
  }
  return names.filter((name) => !name.startsWith('.') && !root.skip?.includes(name) && isDir(path.join(root.dir, name)) && fs.existsSync(path.join(root.dir, name, SKILL_FILE)))
}

function walkSkillDirs(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string, depth: number) => {
    if (out.length >= MAX_WALK_ENTRIES || depth > MAX_WALK_DEPTH) return
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (dir !== root && ents.some((e) => e.isFile() && e.name === SKILL_FILE)) {
      out.push(path.relative(root, dir))
      return
    }
    for (const e of ents) if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') visit(path.join(dir, e.name), depth + 1)
  }
  visit(root, 0)
  return out
}

function stashRoot(env: LocalEnv, root: string): string {
  return path.join(env.stateDir, STASH_DIR, hashText(pathKey(root)))
}

function readStash(env: LocalEnv): StashEntry[] {
  try {
    const data = readJson<{ entries?: StashEntry[] }>(path.join(env.stateDir, STASH_INDEX), {})
    return (data.entries ?? []).filter((e) => e && typeof e.root === 'string' && typeof e.rel === 'string' && typeof e.stash === 'string')
  } catch {
    return []
  }
}

function writeStash(env: LocalEnv, entries: StashEntry[]): void {
  writeTextSafely(path.join(env.stateDir, STASH_INDEX), `${JSON.stringify({ entries }, null, 2)}\n`, false)
}

function toEntry(root: SkillRoot, rel: string, dir: string, stashed: boolean): LocalSkillEntry {
  const parsed = parseSkillMarkdown(readText(path.join(dir, SKILL_FILE)) ?? '')
  const origin = fs.existsSync(path.join(dir, MARKER)) ? 'app' : root.origin
  return {
    id: JSON.stringify([path.resolve(root.dir), rel]),
    cli: root.cli,
    origin,
    ...(root.projectPath ? { projectPath: root.projectPath } : {}),
    name: parsed.name?.trim() || path.basename(rel),
    description: parsed.description?.trim() ?? '',
    enabled: !stashed,
    readonly: origin !== 'user' && origin !== 'project',
    dir,
    root: root.dir
  }
}

function collect(env: LocalEnv, projects: string[]): { found: Found[]; errors: ReportError[] } {
  const found: Found[] = []
  const errors: ReportError[] = []
  const stash = readStash(env)
  for (const root of skillRoots(env, projects)) {
    const rels = root.walk ? walkSkillDirs(root.dir) : childSkillDirs(root)
    for (const rel of rels) found.push({ entry: toEntry(root, rel, path.join(root.dir, rel), false), root, rel, stashed: false })
    if (root.walk) continue
    for (const item of stash) {
      if (!samePath(item.root, root.dir) || rels.includes(item.rel)) continue
      if (!fs.existsSync(path.join(item.stash, SKILL_FILE))) continue
      found.push({ entry: toEntry(root, item.rel, item.stash, true), root, rel: item.rel, stashed: true })
    }
  }
  return { found, errors }
}

export function scanLocalSkills(env: LocalEnv, projects: string[]): LocalSkillReport {
  const { found, errors } = collect(env, projects)
  return { entries: found.map((f) => f.entry), errors }
}

function find(env: LocalEnv, projects: string[], id: string, writable = true): Found {
  const hit = collect(env, projects).found.find((f) => f.entry.id === id)
  if (!hit) throw new LocalConfigError(translate('找不到这个条目，请刷新后再试'))
  if (writable && hit.entry.readonly) {
    throw new LocalConfigError(hit.entry.origin === 'app' ? translate('这个 Skill 由本应用管理，请在“本应用”里修改') : translate('这个 Skill 由 CLI 管理，更新时会被覆盖，不能在这里修改'))
  }
  return hit
}

export function readLocalSkill(env: LocalEnv, projects: string[], id: string): LocalSkillContent {
  const hit = find(env, projects, id, false)
  const text = readText(path.join(hit.entry.dir, SKILL_FILE)) ?? ''
  const parsed = parseSkillMarkdown(text)
  return { name: hit.entry.name, description: hit.entry.description, body: parsed.body, hash: hashText(text) }
}

/** Names already on disk are kept as they are; new and renamed skills must use the portable form. */
function validate(req: LocalSkillSaveRequest, previous?: string): { name: string; description: string } {
  const name = req.name.trim()
  const description = req.description.trim()
  if (!name) throw new LocalConfigError(translate('请填写名称'))
  if (name !== previous && !isValidSkillName(name)) throw new LocalConfigError(translate('Skill 名称只能使用小写字母、数字和连字符'))
  if (!description) throw new LocalConfigError(translate('请填写描述'))
  return { name, description }
}

function taken(env: LocalEnv, rootDir: string, rel: string): boolean {
  return fs.existsSync(path.join(rootDir, rel)) || readStash(env).some((item) => samePath(item.root, rootDir) && item.rel === rel)
}

export function saveLocalSkill(env: LocalEnv, projects: string[], req: LocalSkillSaveRequest): void {
  if (!req.id) {
    const { name, description } = validate(req)
    const root = targetRoot(env, projects, req.target)
    if (taken(env, root.dir, name)) throw new LocalConfigError(translate('{path} 已存在', { path: path.join(root.dir, name) }))
    writeTextSafely(path.join(root.dir, name, SKILL_FILE), renderSkillMarkdown({ id: name, name, description, enabled: true, body: req.body }), false)
    return
  }
  const hit = find(env, projects, req.id)
  const { name, description } = validate(req, hit.entry.name)
  const file = path.join(hit.entry.dir, SKILL_FILE)
  assertUnchanged(file, req.hash)
  const text = updateSkillMarkdown(readText(file) ?? '', name, description, req.body)
  let dir = hit.entry.dir
  // The directory follows the name only when it matched the old name.
  if (name !== hit.rel && hit.rel === hit.entry.name && !hit.rel.includes(path.sep)) {
    if (taken(env, hit.root.dir, name)) throw new LocalConfigError(translate('{path} 已存在', { path: path.join(hit.root.dir, name) }))
    const next = path.join(path.dirname(dir), name)
    moveDir(dir, next)
    dir = next
    if (hit.stashed) {
      writeStash(env, readStash(env).map((item) => (samePath(item.root, hit.root.dir) && item.rel === hit.rel ? { ...item, rel: name, stash: next } : item)))
    }
  }
  writeTextSafely(path.join(dir, SKILL_FILE), text, false)
}

export function toggleLocalSkill(env: LocalEnv, projects: string[], id: string, enabled: boolean): void {
  const hit = find(env, projects, id)
  if (hit.stashed !== enabled) return
  const stash = readStash(env)
  if (!enabled) {
    const held = path.join(stashRoot(env, hit.root.dir), hit.rel)
    if (fs.existsSync(held)) throw new LocalConfigError(translate('{path} 已存在', { path: held }))
    moveDir(hit.entry.dir, held)
    writeStash(env, [...stash, { root: path.resolve(hit.root.dir), rel: hit.rel, stash: held }])
    return
  }
  const dest = path.join(hit.root.dir, hit.rel)
  if (fs.existsSync(dest)) throw new LocalConfigError(translate('{path} 已存在', { path: dest }))
  moveDir(hit.entry.dir, dest)
  writeStash(env, stash.filter((item) => !(samePath(item.root, hit.root.dir) && item.rel === hit.rel)))
}

export async function deleteLocalSkill(env: LocalEnv, projects: string[], id: string, trash: (dir: string) => Promise<void>): Promise<void> {
  const hit = find(env, projects, id)
  await trash(hit.entry.dir)
  if (hit.stashed) writeStash(env, readStash(env).filter((item) => !(samePath(item.root, hit.root.dir) && item.rel === hit.rel)))
}
