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
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const copy = `${file}${BACKUP_SUFFIX}`
  if (backup && fs.existsSync(file) && !fs.existsSync(copy)) fs.copyFileSync(file, copy)
  const tmp = `${file}.agent-desktop.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

export function readJson<T>(file: string, fallback: T): T {
  const text = readText(file)
  if (text === undefined || !text.trim()) return fallback
  return JSON.parse(text.replace(/^\uFEFF/, '')) as T
}

/** Moves a directory, copying when the rename crosses devices. */
export function moveDir(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return norm(a) === norm(b)
}
