import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizePath, Store } from '../src/main/store'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }))
vi.mock('../src/main/codex-history', () => ({
  readCodexUsage: vi.fn(() => { throw new Error('This test must not read CLI history') }),
  repairCodexMcpTools: vi.fn(() => false),
  repairCodexAssistantMessages: vi.fn(() => false)
}))

let store: Store | undefined
const modeOf = (file: string): number => fs.statSync(file).mode & 0o777

beforeEach(() => {
  electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-store-platform-'))
})

afterEach(() => {
  store?.flush()
  store = undefined
  fs.rmSync(electron.userData, { recursive: true, force: true })
  electron.userData = ''
})

describe('platform-specific store paths', () => {
  it('retains the root directory and normalizes other trailing separators', () => {
    const root = path.parse(electron.userData).root
    expect(normalizePath(root)).toBe(process.platform === 'win32' ? root.toLowerCase() : root)
    expect(normalizePath(electron.userData + path.sep)).toBe(normalizePath(electron.userData))
  })

  it.skipIf(process.platform !== 'linux')('preserves legal trailing backslashes in POSIX filenames', () => {
    expect(normalizePath(path.join(electron.userData, 'project\\'))).toBe(path.join(electron.userData, 'project\\'))
  })
})

describe.skipIf(process.platform === 'win32')('private POSIX application state', () => {
  it('creates private data directories, state and transcript files', () => {
    fs.chmodSync(electron.userData, 0o755)
    store = new Store()
    const project = store.addProject(path.join(electron.userData, 'project'))
    store.createThread({ id: 'local-thread', projectId: project.id, title: 'Fixture', cli: 'cursor', mode: 'ask', source: 'app' })
    store.setItems('local-thread', [{ id: 'local-item', kind: 'user', text: 'fixture', createdAt: 1 }])
    store.flush()
    expect(modeOf(electron.userData)).toBe(0o755)
    expect(modeOf(store.dataDir)).toBe(0o700)
    expect(modeOf(path.join(store.dataDir, 'threads'))).toBe(0o700)
    expect(modeOf(path.join(store.dataDir, 'state.json'))).toBe(0o600)
    expect(modeOf(path.join(store.dataDir, 'threads', 'local-thread.json'))).toBe(0o600)
  })

  it('preserves existing directory and state file permissions when saving', () => {
    const data = path.join(electron.userData, 'data')
    fs.mkdirSync(data)
    fs.chmodSync(data, 0o755)
    const state = path.join(data, 'state.json')
    fs.writeFileSync(state, JSON.stringify({ version: 1, projects: [], threads: [], settings: {} }))
    fs.chmodSync(state, 0o640)
    store = new Store()
    store.updateSettings({ theme: 'dark' })
    store.flush()
    expect(modeOf(data)).toBe(0o755)
    expect(modeOf(state)).toBe(0o640)
    expect(JSON.parse(fs.readFileSync(state, 'utf8')).settings.theme).toBe('dark')
  })
})
