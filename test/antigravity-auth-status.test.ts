import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { antigravityCliInfo } from '../src/main/antigravity'
import { findCliExecutable, killCliProcessTree, spawnCliProcess } from '../src/main/cli-runtime'
import { managedExecutable } from '../src/main/managed-cli-location'

vi.mock('../src/main/managed-cli-location', () => ({ managedExecutable: vi.fn() }))
vi.mock('../src/main/cli-runtime', async (original) => ({
  ...await original<typeof import('../src/main/cli-runtime')>(),
  cliSearchDirectories: () => [],
  findCliExecutable: vi.fn(),
  killCliProcessTree: vi.fn((child: ChildProcess) => child.emit('close', 0)),
  spawnCliProcess: vi.fn()
}))

const command = '/cli/agy.exe'
const managed = { command, version: '1.5.13', prefixArgs: [] }

function fakeProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null
  })
}

function acpServer(reply?: { result: unknown } | { error: { code: number; message: string } }) {
  const child = fakeProcess()
  const calls: { method: string; params: unknown }[] = []
  child.stdin.on('data', (chunk: Buffer) => {
    const { id, method, params } = JSON.parse(chunk.toString())
    calls.push({ method, params })
    const response = method === 'initialize' ? { result: { protocolVersion: 1 } } : reply
    if (response) child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...response }) + '\n')
  })
  vi.mocked(spawnCliProcess).mockReturnValue(child as unknown as ChildProcess)
  return { child, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findCliExecutable).mockReturnValue(undefined)
  vi.mocked(managedExecutable).mockReturnValue(managed)
})

afterEach(() => vi.useRealTimers())

it('accepts an authenticated empty session list without opening a session', async () => {
  const { child, calls } = acpServer({ result: { sessions: [] } })
  await expect(antigravityCliInfo('', '')).resolves.toMatchObject({
    found: true, source: 'managed', version: managed.version, authStatus: 'authenticated'
  })
  expect(calls).toEqual([
    { method: 'initialize', params: expect.any(Object) },
    { method: 'session/list', params: { cwd: os.tmpdir() } }
  ])
  expect(killCliProcessTree).toHaveBeenCalledExactlyOnceWith(child)
})

it.each([
  [-32000, 'required'], [-32601, 'unknown'], [-32603, 'unknown']
] as const)('maps ACP error %s to %s without relying on the error text', async (code, status) => {
  acpServer({ error: { code, message: 'Fixture error' } })
  await expect(antigravityCliInfo('', '')).resolves.toMatchObject({ found: true, authStatus: status })
})

it('reports an unrecognized session list as unknown', async () => {
  acpServer({ result: {} })
  await expect(antigravityCliInfo('', '')).resolves.toMatchObject({ found: true, authStatus: 'unknown' })
})

it('kills a nonresponsive process and keeps the installed CLI visible', async () => {
  vi.useFakeTimers()
  const { child } = acpServer()
  const detection = antigravityCliInfo('', '')
  await vi.advanceTimersByTimeAsync(10_000)
  await expect(detection).resolves.toMatchObject({ found: true, authStatus: 'unknown' })
  expect(killCliProcessTree).toHaveBeenCalledExactlyOnceWith(child)
})

it('reports a configured API key without probing the account', async () => {
  await expect(antigravityCliInfo('', 'fixture-key')).resolves.toMatchObject({
    found: true, hasApiKey: true, authStatus: 'api-key'
  })
  expect(spawnCliProcess).not.toHaveBeenCalled()
})

it('retains the upgrade warning for an unsupported standalone binary', async () => {
  vi.mocked(findCliExecutable).mockReturnValue(command)
  const child = fakeProcess()
  vi.mocked(spawnCliProcess).mockImplementation(() => {
    queueMicrotask(() => {
      child.stdout.end('1.4.8\n')
      child.emit('close', 0)
    })
    return child as unknown as ChildProcess
  })
  const info = await antigravityCliInfo(command, '')
  expect(info).toMatchObject({ found: true, source: 'external', version: '1.4.8', status: expect.stringContaining('1.5.0') })
  expect(info.authStatus).toBeUndefined()
  expect(vi.mocked(spawnCliProcess).mock.calls.map(([, args]) => args)).toEqual([['--version']])
})
