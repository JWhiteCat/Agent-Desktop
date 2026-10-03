import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKUP_SUFFIX, pathKey, samePath, writeTextSafely } from '../src/main/local-files'

let root: string
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const modeOf = (file: string): number => fs.statSync(file).mode & 0o777

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-local-files-'))
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('local path identity', () => {
  it.each(['linux', 'darwin'])('preserves case and the filesystem root on %s', (name) => {
    Object.defineProperty(process, 'platform', { ...platform, value: name })
    expect(samePath(path.join(root, 'App'), path.join(root, 'app'))).toBe(false)
    expect(pathKey(path.parse(root).root)).toBe(path.parse(root).root)
    expect(pathKey(path.join(root, 'app') + path.sep)).toBe(path.join(root, 'app'))
  })

  it('keeps Windows path comparison case-insensitive', () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    expect(samePath(path.join(root, 'App'), path.join(root, 'app'))).toBe(true)
  })
})

describe('atomic local configuration writes', () => {
  it('keeps the first backup and leaves no temporary files behind', () => {
    const file = path.join(root, 'config.json')
    fs.writeFileSync(file, 'original')
    writeTextSafely(file, 'first')
    writeTextSafely(file, 'second')
    expect(fs.readFileSync(file, 'utf8')).toBe('second')
    expect(fs.readFileSync(file + BACKUP_SUFFIX, 'utf8')).toBe('original')
    expect(fs.readdirSync(root).sort()).toEqual(['config.json', 'config.json' + BACKUP_SUFFIX])
  })

  it('does not reuse or overwrite a pre-existing fixed-name temporary file', () => {
    const file = path.join(root, 'config.json')
    const stale = file + '.agent-desktop.tmp'
    fs.writeFileSync(stale, 'leave this alone')
    writeTextSafely(file, 'new', false)
    expect(fs.readFileSync(file, 'utf8')).toBe('new')
    expect(fs.readFileSync(stale, 'utf8')).toBe('leave this alone')
  })

  it('cleans its temporary file after a failed replacement without changing the original', () => {
    const file = path.join(root, 'config.json')
    fs.writeFileSync(file, 'original')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('Replacement denied') })
    expect(() => writeTextSafely(file, 'next', false)).toThrow('Replacement denied')
    expect(fs.readFileSync(file, 'utf8')).toBe('original')
    expect(fs.readdirSync(root)).toEqual(['config.json'])
  })

  it('cleans a partially written temporary file and closes it when writing fails', () => {
    const file = path.join(root, 'config.json')
    fs.writeFileSync(file, 'original')
    const write = fs.writeFileSync
    let temporaryFd: number | undefined
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce((fd) => {
      temporaryFd = fd as number
      write(fd, 'partial')
      throw new Error('Disk full')
    })
    expect(() => writeTextSafely(file, 'next', false)).toThrow('Disk full')
    expect(() => fs.fstatSync(temporaryFd!)).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('original')
    expect(fs.readdirSync(root)).toEqual(['config.json'])
  })

  it.skipIf(process.platform === 'win32')('creates private files and directories without chmodding existing directories', () => {
    fs.chmodSync(root, 0o755)
    const file = path.join(root, 'new', 'nested', 'config.json')
    writeTextSafely(file, 'private', false)
    expect(modeOf(file)).toBe(0o600)
    expect(modeOf(path.dirname(file))).toBe(0o700)
    expect(modeOf(path.join(root, 'new'))).toBe(0o700)
    expect(modeOf(root)).toBe(0o755)
  })

  it.skipIf(process.platform === 'win32').each([0o600, 0o640, 0o664])('preserves original mode %i in replacements and backups', (mode) => {
    const file = path.join(root, 'config.json')
    fs.writeFileSync(file, 'original')
    fs.chmodSync(file, mode)
    writeTextSafely(file, 'next')
    expect(modeOf(file)).toBe(mode)
    expect(modeOf(file + BACKUP_SUFFIX)).toBe(mode)
    writeTextSafely(file, 'again')
    expect(modeOf(file)).toBe(mode)
    expect(modeOf(file + BACKUP_SUFFIX)).toBe(mode)
  })
})
