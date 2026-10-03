import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { t as translate } from '@shared/i18n'

/** Home directory and this app's state directory. Tests point both at temporary folders. */
export interface LocalEnv {
  home: string
  stateDir: string
}

export class LocalConfigError extends Error {}

export const BACKUP_SUFFIX = '.agent-desktop.bak'

export function hashText(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)
}

export function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

export function fileHash(file: string): string {
  return hashText(readText(file) ?? '')
}

export function assertUnchanged(file: string, expected: string | undefined): void {
  if (expected !== undefined && fileHash(file) !== expected) {
    throw new LocalConfigError(translate('{path} 已被其他程序修改，请刷新后再试', { path: file }))
  }
}

/** Keeps a copy of the file as it was before this app first changed it, then replaces it atomically. */
export function writeTextSafely(file: string, text: string, backup = true): void {
  // New configuration may contain API keys or MCP credentials. Existing directories
  // belong to the user, so mkdir's mode applies only to directories we create.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  let original: fs.Stats | undefined
  try {
    original = fs.statSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const mode = process.platform === 'win32' ? undefined : original ? original.mode & 0o777 : 0o600
  const copy = `${file}${BACKUP_SUFFIX}`
  if (backup && original && !fs.existsSync(copy)) {
    try {
      fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  // A unique, exclusively created temporary file avoids following an old or
  // attacker-created symlink and keeps concurrent writers' temporary files apart.
  const tmp = `${file}.${crypto.randomUUID()}.agent-desktop.tmp`
  const fd = fs.openSync(tmp, 'wx', mode)
  try {
    fs.writeFileSync(fd, text, 'utf8')
    // open() applies umask; restore the original mode on this new inode only.
    if (mode !== undefined) fs.fchmodSync(fd, mode)
  } catch (error) {
    fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
    throw error
  }
  fs.closeSync(fd)
  try {
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

export function readJson<T>(file: string, fallback: T): T {
  const text = readText(file)
  if (text === undefined || !text.trim()) return fallback
  return JSON.parse(text.replace(/^\uFEFF/, '')) as T
}

/** Moves a directory, copying when the rename crosses devices. */
export function moveDir(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
  try {
    fs.renameSync(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
}

export function pathKey(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}
