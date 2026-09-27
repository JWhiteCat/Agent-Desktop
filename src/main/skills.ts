import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderSkillMarkdown, skillReady } from '@shared/agent-config'
import type { SkillConfig } from '@shared/types'

const MARKER = 'agent-desktop.json'

export class SkillSyncError extends Error {}

export function userSkillsDir(): string {
  return path.join(os.homedir(), '.cursor', 'skills')
}

/** Current Codex user skills, plus the older ~/.codex/skills location. */
export function codexSkillsDirs(): string[] {
  const home = os.homedir()
  return [path.join(home, '.agents', 'skills'), path.join(home, '.codex', 'skills')]
}

export function claudeSkillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills')
}

/** Writes one settings list to Cursor, both Codex skill directories, and Claude. */
export function syncAllManagedSkills(skills: SkillConfig[] | undefined): void {
  syncManagedSkills(skills, userSkillsDir())
  for (const dir of codexSkillsDirs()) syncManagedSkills(skills, dir)
  syncManagedSkills(skills, claudeSkillsDir())
}

/**
 * Writes enabled skills into `~/.cursor/skills/<name>/SKILL.md`.
 * Only directories that contain this app's marker file are replaced or removed.
 */
export function syncManagedSkills(skills: SkillConfig[] | undefined, root = userSkillsDir()): void {
  const enabled = (skills ?? []).filter((skill) => skill.enabled && skillReady(skill))
  if (!fs.existsSync(root)) {
    if (enabled.length === 0) return
    fs.mkdirSync(root, { recursive: true })
  }
  const wanted = new Set(enabled.map((skill) => skill.name.trim()))
  for (const skill of enabled) {
    const name = skill.name.trim()
    const kind = dirKind(path.join(root, name))
    if (kind === 'other' || (kind === 'dir' && !isManaged(path.join(root, name)))) {
      throw new SkillSyncError(`无法写入 Skill「${name}」：${path.join(root, name)} 已存在，且不是本应用创建的`)
    }
  }

  for (const name of readChildDirs(root)) {
    const dir = path.join(root, name)
    if (!isManaged(dir) || wanted.has(name)) continue
    fs.rmSync(dir, { recursive: true, force: true })
  }

  for (const skill of enabled) {
    const name = skill.name.trim()
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillMarkdown(skill), 'utf8')
    fs.writeFileSync(path.join(dir, MARKER), `${JSON.stringify({ managedBy: 'agent-desktop' }, null, 2)}\n`, 'utf8')
  }
}

function readChildDirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).flatMap((ent) => (ent.isDirectory() && !ent.isSymbolicLink() ? [ent.name] : []))
  } catch {
    return []
  }
}

function isManaged(dir: string): boolean {
  return fs.existsSync(path.join(dir, MARKER))
}

function dirKind(dir: string): 'missing' | 'dir' | 'other' {
  try {
    const stat = fs.lstatSync(dir)
    if (stat.isSymbolicLink()) return 'other'
    return stat.isDirectory() ? 'dir' : 'other'
  } catch {
    return 'missing'
  }
}
