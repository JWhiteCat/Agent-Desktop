import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AppState } from '@shared/types'
import { connectAttached } from '../src/cli/client'
import { acquireHeadlessLock, activeHeadlessLock, HeadlessLockConflictError, headlessLockPath } from '../src/main/headless-lock'
import {
  cleanupLocalControlFiles,
  handlersForLocalCli,
  localControlFilePath,
  LocalControlServer,
  probeLocalControl,
  readLocalControlMeta,
  type LocalControlMeta
} from '../src/main/local-control'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    systemLocale: 'en-US',
    projects: [],
    threads: [],
    settings: {
      ...DEFAULT_SETTINGS,
      apiKey: 'secret-cursor-key',
      codexApiKey: 'secret-codex-key',
      claudeApiKey: 'secret-claude-key',
      antigravityApiKey: 'secret-ag-key',
      remoteToken: 'secret-remote-token'
    },
    running: [],
    starting: [],
    waitingForInput: [],
    queued: {},
    ...overrides
  }
}

function rawIpcRequest(socketPath: string, reqPath: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: reqPath, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

describe('LocalControlServer and headless-lock', () => {
  let tmpDir: string
  let server: LocalControlServer

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-local-ctrl-'))
    server = new LocalControlServer()
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('starts over local IPC, enforces token auth, filters unsafe channels, and streams SSE events', async () => {
    const state = makeState()
    const rawHandlers = {
      'state:get': () => state,
      'project:pick': () => { throw new Error('must not be exposed') },
      'project:add': (dir: string) => ({ id: 'p1', name: path.basename(dir), path: dir, createdAt: 1 })
    }
    const meta = await server.start({
      dataDir: tmpDir,
      appVersion: '0.1.0-test',
      handlers: handlersForLocalCli(rawHandlers, () => state)
    })

    expect(meta).toBeDefined()
    expect(readLocalControlMeta(tmpDir)).toEqual(meta)

    // Health check with valid token succeeds.
    const health = await probeLocalControl(meta!)
    expect(health).toMatchObject({ ok: true, pid: process.pid, appVersion: '0.1.0-test' })

    // Invalid token is rejected with 401.
    const unauth = await rawIpcRequest(meta!.socketPath, '/api/health', 'GET', { 'x-token': 'wrong' })
    expect(unauth.status).toBe(401)

    // Dialog-only channel is blocked (404).
    const blocked = await rawIpcRequest(
      meta!.socketPath,
      '/api/rpc/project%3Apick',
      'POST',
      { 'x-token': meta!.token, 'content-type': 'application/json' },
      '[]'
    )
    expect(blocked.status).toBe(404)

    // Attached client reads scrubbed state (no secrets leaked) and invokes allowed RPC.
    const client = await connectAttached(tmpDir)
    expect(client).toBeDefined()
    const remoteState = await client!.call<AppState>('state:get')
    expect(remoteState.settings.apiKey).toBe('')
    expect(remoteState.settings.codexApiKey).toBe('')
    expect(remoteState.settings.claudeApiKey).toBe('')
    expect(remoteState.settings.antigravityApiKey).toBe('')
    expect(remoteState.settings.remoteToken).toBe('')

    const added = await client!.call<{ id: string }>('project:add', tmpDir)
    expect(added.id).toBe('p1')

    // SSE delivery works.
    const received: unknown[] = []
    const unsub = await client!.subscribe({
      onEvent: (ev) => received.push(ev)
    })
    server.broadcast('agent:event', { type: 'running', threadId: 't1', running: true })
    await new Promise((r) => setTimeout(r, 40))
    expect(received).toEqual([{ type: 'running', threadId: 't1', running: true }])

    unsub()
    await client!.close()
    await server.stop()
    expect(fs.existsSync(localControlFilePath(tmpDir))).toBe(false)
  })

  it('cleans up stale cli-control.json when the recorded PID is dead', async () => {
    const stalePath = localControlFilePath(tmpDir)
    fs.writeFileSync(stalePath, JSON.stringify({
      version: 1,
      pid: 99999999,
      socketPath: process.platform === 'win32' ? '\\\\.\\pipe\\agent-desktop-cli-nonexistent-dead' : path.join(tmpDir, 'dead.sock'),
      token: 'dead-token',
      appVersion: '0.1.0',
      startedAt: 1
    }))

    const client = await connectAttached(tmpDir, 150)
    expect(client).toBeUndefined()
    expect(fs.existsSync(stalePath)).toBe(false)
  })

  it('enforces exclusive headless lock and recovers stale locks', () => {
    const lock = acquireHeadlessLock(tmpDir, 'run')
    expect(activeHeadlessLock(tmpDir)?.pid).toBe(process.pid)
    expect(() => acquireHeadlessLock(tmpDir, 'status')).toThrow(HeadlessLockConflictError)

    lock.release()
    expect(activeHeadlessLock(tmpDir)).toBeUndefined()

    // Write a stale lock for a dead PID; next acquire should reclaim it cleanly.
    fs.writeFileSync(headlessLockPath(tmpDir), JSON.stringify({ version: 1, pid: 99999999, startedAt: 1 }))
    const reclaimed = acquireHeadlessLock(tmpDir, 'status')
    expect(reclaimed.info.pid).toBe(process.pid)
    reclaimed.release()
  })

  it('guards POSIX Unix socket unlink inside the metadata ownership check (#15)', () => {
    const sockPath = path.join(tmpDir, 'cli-ipc.sock')
    fs.writeFileSync(sockPath, 'live-socket')

    const ownerMeta: LocalControlMeta = {
      version: 1,
      pid: 22222,
      socketPath: sockPath,
      token: 'owner-token',
      appVersion: '0.1.0',
      startedAt: 200
    }
    const staleMeta: LocalControlMeta = {
      version: 1,
      pid: 11111,
      socketPath: sockPath,
      token: 'old-token',
      appVersion: '0.1.0',
      startedAt: 100
    }
    fs.writeFileSync(localControlFilePath(tmpDir), JSON.stringify(ownerMeta))

    // Non-owner cleanup must leave both cli-control.json and the POSIX socket untouched.
    cleanupLocalControlFiles(tmpDir, staleMeta, 'linux')
    expect(fs.existsSync(localControlFilePath(tmpDir))).toBe(true)
    expect(fs.existsSync(sockPath)).toBe(true)

    // Matching owner removes both cli-control.json and the POSIX socket.
    cleanupLocalControlFiles(tmpDir, ownerMeta, 'linux')
    expect(fs.existsSync(localControlFilePath(tmpDir))).toBe(false)
    expect(fs.existsSync(sockPath)).toBe(false)
  })

  it('guards SSE heartbeat and broadcast writes against throwing clients without dropping healthy ones (#28)', () => {
    const clients = (server as unknown as { clients: Set<http.ServerResponse> }).clients
    const received: string[] = []
    const broken = {
      destroyed: false,
      writableEnded: false,
      write: vi.fn(() => { throw new Error('EPIPE') }),
      destroy: vi.fn()
    } as unknown as http.ServerResponse
    const healthy = {
      destroyed: false,
      writableEnded: false,
      write: vi.fn((chunk: string) => { received.push(chunk); return true }),
      destroy: vi.fn()
    } as unknown as http.ServerResponse

    clients.add(broken)
    clients.add(healthy)

    expect(() => server.broadcast('state:changed', { ok: true })).not.toThrow()
    expect(clients.has(broken)).toBe(false)
    expect(clients.has(healthy)).toBe(true)
    expect(received).toHaveLength(1)
    expect(received[0]).toContain('"state:changed"')

    // Also verify writeSse used by the heartbeat interval handles throwing clients safely.
    const broken2 = {
      destroyed: false,
      writableEnded: false,
      write: vi.fn(() => { throw new Error('ECONNRESET') }),
      destroy: vi.fn()
    } as unknown as http.ServerResponse
    clients.add(broken2)
    const writeSse = (server as unknown as { writeSse: (frame: string) => void }).writeSse.bind(server)
    expect(() => writeSse('data: {"channel":"transport:ping","payload":null}\n\n')).not.toThrow()
    expect(clients.has(broken2)).toBe(false)
    expect(received).toHaveLength(2)
  })
})
