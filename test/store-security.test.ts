import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AppState } from '@shared/types'
import { HeadlessCliRuntime } from '../src/cli/headless'
import { CliError, EXIT_CONFLICT } from '../src/cli/types'
import {
  acquireDesktopStartupLock,
  acquireHeadlessLock,
  activeHeadlessLock,
  HeadlessLockConflictError,
  headlessLockPath
} from '../src/main/headless-lock'
import { handlersForLocalCli, LocalControlServer } from '../src/main/local-control'
import { Store } from '../src/main/store'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }))

describe('Store security and state persistence guards', () => {
  let tmpRoot: string
  let dataDir: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-store-sec-'))
    electron.userData = tmpRoot
    dataDir = path.join(tmpRoot, 'data')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  describe('threadFile path traversal and itemsCache shape validation (#1)', () => {
    it('blocks traversed and unregistered IDs from reading or caching state.json secrets', () => {
      const store = new Store()
      store.updateSettings({
        apiKey: 'secret-cursor',
        codexApiKey: 'secret-codex',
        claudeApiKey: 'secret-claude',
        antigravityApiKey: 'secret-agy',
        remoteToken: 'secret-remote'
      })
      store.flush()

      // Repeated calls must never cache or return state.json (regression for 2-call cache leak).
      expect(store.items('../state')).toEqual([])
      expect(store.items('../state')).toEqual([])
      expect(store.items('..\\state')).toEqual([])
      expect(store.items('nested/thread')).toEqual([])
      expect(store.items('unregistered-id')).toEqual([])
      expect(store.peekItems('../state')).toEqual([])
    })

    it('blocks traversed and unregistered IDs from deleting arbitrary .json files', () => {
      const store = new Store()
      store.updateSettings({ remoteToken: 'keep-me' })
      store.flush()

      const arrayVictim = path.join(dataDir, 'victim-array.json')
      const rawVictim = path.join(dataDir, 'victim-raw.json')
      fs.writeFileSync(arrayVictim, JSON.stringify([{ id: 'x', kind: 'user', text: 'do not delete' }]))
      fs.writeFileSync(rawVictim, '{ not valid json')

      store.deleteThread('../state')
      store.deleteThread('../victim-array')
      store.deleteThread('../victim-raw')
      store.deleteThread('..\\victim-array')

      expect(fs.existsSync(path.join(dataDir, 'state.json'))).toBe(true)
      expect(fs.existsSync(arrayVictim)).toBe(true)
      expect(fs.existsSync(rawVictim)).toBe(true)
    })

    it('rejects invalid thread IDs in createThread and confines tampered state.json thread IDs', () => {
      const store = new Store()
      const project = store.addProject(tmpRoot, 'proj')
      expect(() => store.createThread({ id: '../state', projectId: project.id, title: 'Bad', mode: 'agent', source: 'app' })).toThrow(/Invalid thread id/)
      expect(() => store.createThread({ id: 'a/b', projectId: project.id, title: 'Bad', mode: 'agent', source: 'app' })).toThrow(/Invalid thread id/)
      expect(() => store.createThread({ id: 'a\\b', projectId: project.id, title: 'Bad', mode: 'agent', source: 'app' })).toThrow(/Invalid thread id/)
      expect(() => store.createThread({ id: 'C:evil', projectId: project.id, title: 'Bad', mode: 'agent', source: 'app' })).toThrow(/Invalid thread id/)
      store.flush()

      // Even if state.json was tampered externally to register a traversed thread ID,
      // Store must still refuse to read or delete files outside threads/.
      const statePath = path.join(dataDir, 'state.json')
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      state.threads.push({
        id: '../state',
        projectId: project.id,
        title: 'Tampered',
        mode: 'agent',
        source: 'app',
        createdAt: 1,
        updatedAt: 1
      })
      fs.writeFileSync(statePath, JSON.stringify(state))

      const reloaded = new Store()
      expect(reloaded.items('../state')).toEqual([])
      expect(reloaded.items('../state')).toEqual([])
      expect(reloaded.peekItems('../state')).toEqual([])
      reloaded.deleteThread('../state')
      expect(fs.existsSync(statePath)).toBe(true)
    })

    it('validates array shape before caching transcript JSON in itemsCache', () => {
      const store = new Store()
      const project = store.addProject(tmpRoot, 'proj')
      const thread = store.createThread({ id: 'valid-thread', projectId: project.id, title: 'T', mode: 'agent', source: 'app' })
      store.flush()

      const threadPath = path.join(dataDir, 'threads', `${thread.id}.json`)
      fs.writeFileSync(threadPath, JSON.stringify({ secret: 'not-an-array' }))

      const reloaded = new Store()
      expect(reloaded.items(thread.id)).toEqual([])
      expect(reloaded.items(thread.id)).toEqual([])
      expect(reloaded.peekItems(thread.id)).toEqual([])
    })
  })

  describe('state.json error handling and corruption backup (#9)', () => {
    it('throws on non-ENOENT read errors instead of overwriting state.json with empty defaults', () => {
      const store = new Store()
      store.addProject(tmpRoot, 'important-project')
      store.updateSettings({ apiKey: 'preserve-me' })
      store.flush()

      const statePath = path.join(dataDir, 'state.json')
      const originalContent = fs.readFileSync(statePath, 'utf8')
      const realReadFileSync = fs.readFileSync.bind(fs)
      vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof file === 'string' && path.resolve(file) === path.resolve(statePath)) {
          throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' })
        }
        return (realReadFileSync as (...args: unknown[]) => unknown)(file, ...rest)
      }) as typeof fs.readFileSync)

      expect(() => new Store()).toThrow(/resource busy or locked/)
      vi.restoreAllMocks()
      expect(fs.readFileSync(statePath, 'utf8')).toBe(originalContent)
    })

    it('backs up corrupted JSON state.json before initializing defaults and skips attachment GC', () => {
      fs.mkdirSync(dataDir, { recursive: true })
      const statePath = path.join(dataDir, 'state.json')
      const broken = '{ "version": 1, "projects": [ { "id": "p1" '
      fs.writeFileSync(statePath, broken, 'utf8')

      // Place an existing referenced attachment that would be deleted if GC ran with empty threads.
      const attachId = '11111111-1111-4111-8111-111111111111'
      const attachDir = path.join(dataDir, 'attachments', attachId)
      fs.mkdirSync(attachDir, { recursive: true })
      fs.writeFileSync(path.join(attachDir, 'note.txt'), 'hello')
      fs.writeFileSync(path.join(attachDir, '_metadata.json'), JSON.stringify({
        id: attachId,
        name: 'note.txt',
        mimeType: 'text/plain',
        size: 5,
        createdAt: 1,
        referenced: true
      }))

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const store = new Store()
      expect(store.projects).toEqual([])
      expect(errSpy).toHaveBeenCalled()

      const backups = fs.readdirSync(dataDir).filter((name) => name.startsWith('state.json.corrupt-') && name.endsWith('.bak'))
      expect(backups).toHaveLength(1)
      expect(fs.readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe(broken)
      // Attachment must still exist so user can restore from backup without losing attachments.
      expect(fs.existsSync(path.join(attachDir, 'note.txt'))).toBe(true)
    })

    it('backs up non-object JSON state.json (e.g. array) before resetting', () => {
      fs.mkdirSync(dataDir, { recursive: true })
      const statePath = path.join(dataDir, 'state.json')
      fs.writeFileSync(statePath, '["unexpected"]', 'utf8')

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const store = new Store()
      expect(store.projects).toEqual([])
      expect(errSpy).toHaveBeenCalled()

      const backups = fs.readdirSync(dataDir).filter((name) => name.startsWith('state.json.corrupt-') && name.endsWith('.bak'))
      expect(backups).toHaveLength(1)
      expect(fs.readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe('["unexpected"]')
    })

    it('refuses to overwrite corrupted state.json if backup creation fails', () => {
      fs.mkdirSync(dataDir, { recursive: true })
      const statePath = path.join(dataDir, 'state.json')
      const broken = '{ broken'
      fs.writeFileSync(statePath, broken, 'utf8')

      vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      })

      expect(() => new Store()).toThrow(/disk full/)
      expect(fs.readFileSync(statePath, 'utf8')).toBe(broken)
    })

    it('loads UTF-8 BOM-prefixed valid state.json cleanly without backing up as corrupt', () => {
      fs.mkdirSync(dataDir, { recursive: true })
      const statePath = path.join(dataDir, 'state.json')
      fs.writeFileSync(statePath, `\uFEFF${JSON.stringify({
        version: 1,
        projects: [{ id: 'p1', name: 'BOM Project', path: tmpRoot, createdAt: 1 }],
        threads: [],
        settings: {}
      })}`, 'utf8')

      const store = new Store()
      expect(store.projects).toHaveLength(1)
      expect(store.projects[0].name).toBe('BOM Project')
      const backups = fs.readdirSync(dataDir).filter((name) => name.startsWith('state.json.corrupt-'))
      expect(backups).toHaveLength(0)
    })
  })

  describe('Desktop startup and Headless CLI lock coordination (#8)', () => {
    it('blocks desktop startup lock while a live headless CLI holds cli-headless.lock', async () => {
      const cliLock = acquireHeadlessLock(dataDir, 'run')
      try {
        const res = await acquireDesktopStartupLock(dataDir, { waitMs: 60, pollMs: 15 })
        expect(res.ok).toBe(false)
        if (!res.ok) {
          expect(res.holder.pid).toBe(process.pid)
          expect(res.holder.command).toBe('run')
        }
      } finally {
        cliLock.release()
      }
    })

    it('acquires desktop startup lock once a short-lived headless CLI releases its lock', async () => {
      const cliLock = acquireHeadlessLock(dataDir, 'status')
      setTimeout(() => cliLock.release(), 40)

      const res = await acquireDesktopStartupLock(dataDir, { waitMs: 500, pollMs: 15 })
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.lock.info.owner).toBe('desktop')
        expect(() => acquireHeadlessLock(dataDir, 'run')).toThrow(HeadlessLockConflictError)
        expect(() => acquireHeadlessLock(dataDir, 'run')).toThrow(/Agent Desktop .* is starting up/)
        res.lock.release()
      }
      expect(activeHeadlessLock(dataDir)).toBeUndefined()
    })

    it('reclaims a stale cli-headless.lock from a dead PID during desktop startup', async () => {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(headlessLockPath(dataDir), JSON.stringify({ version: 1, pid: 99999999, startedAt: 1 }))

      const res = await acquireDesktopStartupLock(dataDir, { waitMs: 50, pollMs: 10 })
      expect(res.ok).toBe(true)
      if (res.ok) res.lock.release()
    })

    it('prevents HeadlessCliRuntime from opening Store while Desktop LocalControlServer is active', async () => {
      const server = new LocalControlServer()
      const state: AppState = {
        systemLocale: 'en-US',
        projects: [],
        threads: [],
        settings: { ...DEFAULT_SETTINGS },
        running: [],
        starting: [],
        waitingForInput: [],
        queued: {}
      }
      try {
        await server.start({
          dataDir,
          appVersion: '0.1.0-test',
          handlers: handlersForLocalCli({ 'state:get': () => state }, () => state)
        })

        let caught: unknown
        try {
          new HeadlessCliRuntime(dataDir, 'status')
        } catch (err) {
          caught = err
        }
        expect(caught).toBeInstanceOf(CliError)
        expect((caught as CliError).exitCode).toBe(EXIT_CONFLICT)
        // Lock must have been released after rejecting.
        expect(activeHeadlessLock(dataDir)).toBeUndefined()
      } finally {
        await server.stop()
      }
    })
  })
})
