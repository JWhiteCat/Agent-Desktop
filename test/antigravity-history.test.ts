import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { readAntigravityTranscript, scanAntigravitySessions } from '../src/main/antigravity-history'
import { forkPrompt } from '../src/main/fork-context'
import { DEFAULT_SETTINGS } from '../src/shared/types'

const { withAcp, managedExecutable } = vi.hoisted(() => ({ withAcp: vi.fn(), managedExecutable: vi.fn() }))
vi.mock('../src/main/managed-cli-location', () => ({ managedExecutable }))
vi.mock('../src/main/antigravity', async (original) => ({
  ...await original<typeof import('../src/main/antigravity')>(),
  withAntigravityAcp: withAcp
}))

const settings = { ...DEFAULT_SETTINGS, antigravityPath: process.execPath }
const cwd = path.dirname(process.execPath)

it('follows the Antigravity list cursor and recognizes imported conversations', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ sessions: [{ sessionId: 'first', cwd, title: 'First', updatedAt: '2026-11-16T00:00:00Z' }], nextCursor: 'page-two' })
    .mockResolvedValueOnce({ sessions: [{ sessionId: 'second', cwd }] })
  withAcp.mockImplementationOnce((_cli, _cwd, _key, run) => run({ request }))
  expect(await scanAntigravitySessions(settings, new Set(['first']))).toMatchObject([
    { chatId: 'first', cwd, title: 'First', imported: true, cli: 'antigravity', updatedAt: Date.UTC(2026, 10, 16) },
    { chatId: 'second', cwd, titleKind: 'untitled', imported: false }
  ])
  expect(request.mock.calls).toEqual([['session/list', {}], ['session/list', { cursor: 'page-two' }]])
})

it('replays only the requested session and restores copied fork context before the user message', async () => {
  const text = forkPrompt([{ kind: 'assistant', id: 'old', text: 'Copied reply' }], 'Follow up')
  withAcp.mockImplementationOnce((_cli, _cwd, _key, run, notify) => run({
    request: async (method: string, params: unknown) => {
      expect(method).toBe('session/load')
      expect(params).toEqual({ sessionId: 'saved', cwd, mcpServers: [] })
      const update = (sessionId: string, sessionUpdate: string, text: string) =>
        notify('session/update', { sessionId, update: { sessionUpdate, content: { type: 'text', text } } })
      update('other', 'agent_message_chunk', 'Ignore')
      update('saved', 'user_message_chunk', text.slice(0, 25))
      update('saved', 'user_message_chunk', text.slice(25))
      update('saved', 'agent_message_chunk', 'Reply')
      return {}
    }
  }))
  expect(await readAntigravityTranscript(settings, 'saved', cwd)).toMatchObject([
    { kind: 'assistant', text: 'Copied reply' },
    { kind: 'user', text: 'Follow up' },
    { kind: 'assistant', text: 'Reply' }
  ])
})

it('lists both Antigravity stores and loads a registry session through its recorded runtime', async () => {
  const entry = { command: path.join(cwd, 'agy_acp_server.exe'), prefixArgs: [], version: '1.5.0' }
  managedExecutable.mockReturnValue(entry)
  const mockRpc = (_cli: unknown, _cwd: string, _key: string, run: (acp: unknown) => Promise<unknown>) => run({
    request: vi.fn(async () => ({ sessions: [{ sessionId: 'imported', cwd }] }))
  })
  withAcp.mockImplementationOnce(mockRpc).mockImplementationOnce(mockRpc)
  const sessions = await scanAntigravitySessions(settings, new Set())
  expect(sessions.map((session) => session.antigravityRuntime)).toEqual(['cli', 'registry'])
  withAcp.mockImplementationOnce((cli, _cwd, _key, run) => {
    expect(cli).toMatchObject({ antigravityRuntime: 'registry', command: entry.command })
    return run({ request: vi.fn(async () => ({})) })
  })
  await readAntigravityTranscript(settings, 'imported', cwd, undefined, 'registry')
  managedExecutable.mockReset()
})
