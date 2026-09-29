import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCodexSessionUsage } from '../src/main/codex-session-usage'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: fetchMock } }))

const threadId = 'thread-current'
const dataAsOf = '2026-09-29T08:00:00Z'
const payload = {
  data_as_of: dataAsOf,
  threads: [{
    thread_id: threadId,
    data_status: 'available',
    usage_source: 'task',
    five_hour_limit_percent: null,
    weekly_limit_percent: 18.899977777777778,
    balance_usage_credits: null,
    groups: []
  }]
}

beforeEach(() => {
  vi.stubEnv('CODEX_API_KEY', '')
  vi.stubEnv('OPENAI_API_KEY', '')
  vi.stubEnv('CODEX_HOME', '')
  vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
    tokens: { access_token: 'private-access-token', account_id: 'private-account-id' }
  }))
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => payload })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Codex consumer task usage client', () => {
  it('queries this thread with consumer query v2, account authentication, and an eight second deadline', async () => {
    const signal = new AbortController().signal
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
    const result = await loadCodexSessionUsage(threadId, Date.parse('2026-09-29T06:30:00Z'), ['thread-child'])
    expect(result).toEqual({ threadId, status: 'available', weekly: 18.899977777777778, dataAsOf })
    expect(timeout).toHaveBeenCalledExactlyOnceWith(8_000)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://chatgpt.com/backend-api/wham/usage/thread_usage/query_v2', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer private-access-token',
        'Content-Type': 'application/json',
        'ChatGPT-Account-Id': 'private-account-id'
      },
      body: JSON.stringify({ threads: [{
        thread_id: threadId,
        created_at: '2026-09-29T06:30:00.000Z',
        descendant_thread_ids: ['thread-child']
      }] }),
      signal
    })
    expect(JSON.stringify(result)).not.toContain('private-access-token')
    expect(JSON.stringify(result)).not.toContain('private-account-id')
  })

  it('preserves unavailable task status without copying account usage or inventing zeroes', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      ...payload,
      threads: [{ ...payload.threads[0], data_status: 'unavailable', weekly_limit_percent: null }],
      rate_limit: { primary_window: { used_percent: 75 } }
    }) })
    expect(await loadCodexSessionUsage(threadId)).toEqual({ threadId, status: 'unavailable', dataAsOf })
  })

  it('retains the partial result including explicit zero and exact balance credits', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      ...payload,
      threads: [{
        ...payload.threads[0], data_status: 'partial', five_hour_limit_percent: 0,
        balance_usage_credits: '0.123456789123456789'
      }]
    }) })
    expect(await loadCodexSessionUsage(threadId)).toEqual({
      threadId, status: 'partial', fiveHour: 0, weekly: 18.899977777777778,
      balanceCredits: '0.123456789123456789', dataAsOf
    })
  })

  it('reads credentials from CODEX_HOME and supports tokens without an account ID', async () => {
    const authHome = path.resolve('test-codex-home')
    vi.stubEnv('CODEX_HOME', ` ${authHome} `)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ access_token: 'private-access-token' }))
    await loadCodexSessionUsage(threadId)
    expect(fs.readFileSync).toHaveBeenCalledExactlyOnceWith(path.join(authHome, 'auth.json'), 'utf8')
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      Authorization: 'Bearer private-access-token', 'Content-Type': 'application/json'
    })
  })

  it.each([undefined, NaN, Infinity, -Infinity, 1e30, 0, -1])('uses null for an unavailable or invalid timestamp: %s', async (createdAt) => {
    await loadCodexSessionUsage(threadId, createdAt)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      threads: [{ thread_id: threadId, created_at: null, descendant_thread_ids: [] }]
    })
  })

  it('sends each valid descendant once and excludes the root', async () => {
    await loadCodexSessionUsage(threadId, undefined, [threadId, 'child-a', 'child-a', '', ' ', 'x'.repeat(513), 'child-b'])
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).threads[0].descendant_thread_ids).toEqual(['child-a', 'child-b'])
  })

  it('does not omit descendants when a query exceeds the server ID limit', async () => {
    const descendants = Array.from({ length: 1_000 }, (_, index) => `child-${index}`)
    expect(await loadCodexSessionUsage(threadId, undefined, descendants)).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    await loadCodexSessionUsage(threadId, undefined, descendants.slice(0, 999))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).threads[0].descendant_thread_ids).toHaveLength(999)
  })

  it.each(['CODEX_API_KEY', 'OPENAI_API_KEY'])('skips ChatGPT quota when authenticated with %s', async (name) => {
    vi.stubEnv(name, 'private-api-key')
    expect(await loadCodexSessionUsage(threadId)).toBeUndefined()
    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([{ auth_mode: 'apikey' }, { OPENAI_API_KEY: 'private-api-key' }])('skips stored API key authentication: %j', async (auth) => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ...auth, tokens: { access_token: 'old-token' } }))
    expect(await loadCodexSessionUsage(threadId)).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('contains missing and malformed authentication without issuing a request', async () => {
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw new Error('missing auth') })
    expect(await loadCodexSessionUsage(threadId)).toBeUndefined()
    vi.mocked(fs.readFileSync).mockReturnValueOnce('{')
    expect(await loadCodexSessionUsage(threadId)).toBeUndefined()
    vi.mocked(fs.readFileSync).mockReturnValueOnce('{}')
    expect(await loadCodexSessionUsage(threadId)).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['', ' ', 'x'.repeat(513), '界'.repeat(171)])('rejects invalid root IDs before reading credentials: %s', async (id) => {
    expect(await loadCodexSessionUsage(id)).toBeUndefined()
    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([401, 403, 404, 429, 503])('contains authentication and unsupported/server errors: HTTP %i', async (status) => {
    fetchMock.mockResolvedValueOnce({ ok: false, status })
    expect(await loadCodexSessionUsage(threadId)).toBeUndefined()
  })

  it('contains network, timeout, and invalid JSON failures without exposing credentials', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined)
    for (const failure of [new Error('private-access-token'), new DOMException('Timed out', 'TimeoutError')]) {
      fetchMock.mockRejectedValueOnce(failure)
      expect(await loadCodexSessionUsage(threadId)).toBeUndefined()
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('private-access-token') } })
    expect(await loadCodexSessionUsage(threadId)).toBeUndefined()
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('does not accept task usage for another thread', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      ...payload, threads: [{ ...payload.threads[0], thread_id: 'different-thread' }]
    }) })
    expect(await loadCodexSessionUsage(threadId)).toBeUndefined()
  })
})
