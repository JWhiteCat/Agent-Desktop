import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCodexQuotaSnapshot, loadQuotas } from '../src/main/quota'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: fetchMock } }))

const usage = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 2_000_000_000 },
    secondary_window: { used_percent: 10, limit_window_seconds: 604_800, reset_at: 2_000_500_000 }
  }
}

function storedAuth(accountId: string | undefined = 'account-test', token = 'test-access-token'): string {
  return JSON.stringify({ tokens: { access_token: token, account_id: accountId } })
}

beforeEach(() => {
  vi.stubEnv('CODEX_API_KEY', '')
  vi.stubEnv('OPENAI_API_KEY', '')
  vi.stubEnv('CURSOR_API_KEY', '')
  vi.stubEnv('CODEX_HOME', '')
  vi.spyOn(fs, 'readFileSync').mockReturnValue(storedAuth())
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => usage })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Codex quota snapshots', () => {
  it('returns quota and a hashed account identity with a short request timeout', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const signal = new AbortController().signal
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
    const snapshot = await loadCodexQuotaSnapshot()
    expect(snapshot?.quota.windows).toHaveLength(2)
    expect(snapshot?.sampledAt).toBe(1_000)
    expect(snapshot?.accountKey).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(snapshot)).not.toContain('test-access-token')
    expect(JSON.stringify(snapshot)).not.toContain('account-test')
    expect(timeout).toHaveBeenCalledWith(5_000)
    expect(fetchMock).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', {
      headers: { Authorization: 'Bearer test-access-token', 'ChatGPT-Account-Id': 'account-test' },
      signal
    })
  })

  it('keeps the normal settings request timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal)
    const report = await loadQuotas(undefined, undefined)
    expect(report.codex.windows).toHaveLength(2)
    expect(timeout).toHaveBeenCalledWith(15_000)
    expect(report.codex).not.toHaveProperty('accountKey')
  })

  it('keeps account identity stable across token refreshes', async () => {
    const first = await loadCodexQuotaSnapshot()
    vi.mocked(fs.readFileSync).mockReturnValue(storedAuth('account-test', 'refreshed-access-token'))
    const second = await loadCodexQuotaSnapshot()
    expect(second?.accountKey).toBe(first?.accountKey)
    vi.mocked(fs.readFileSync).mockReturnValue(storedAuth('other-account', 'refreshed-access-token'))
    expect((await loadCodexQuotaSnapshot())?.accountKey).not.toBe(first?.accountKey)
  })

  it('hashes the token when no account identity is available', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ tokens: { access_token: 'first-token' } }))
    const first = await loadCodexQuotaSnapshot()
    expect(first?.accountKey).toMatch(/^[a-f0-9]{64}$/)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ tokens: { access_token: 'second-token' } }))
    expect((await loadCodexQuotaSnapshot())?.accountKey).not.toBe(first?.accountKey)
  })

  it.each(['settings', 'CODEX_API_KEY', 'OPENAI_API_KEY'])('prefers %s API keys over stored ChatGPT tokens', async (source) => {
    const settings = source === 'settings' ? 'configured-api-key' : undefined
    if (source !== 'settings') vi.stubEnv(source, 'environment-api-key')
    expect(await loadCodexQuotaSnapshot(settings)).toBeUndefined()
    expect((await loadQuotas(undefined, settings)).codex.note).toContain('API Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([{ auth_mode: 'apikey' }, { OPENAI_API_KEY: 'stored-api-key' }])('respects stored API key auth despite leftover tokens: %j', async (auth) => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ...auth, tokens: { access_token: 'old-token' } }))
    expect(await loadCodexQuotaSnapshot()).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the auth file from CODEX_HOME when configured', async () => {
    vi.stubEnv('CODEX_HOME', path.resolve('test-codex-home'))
    await loadCodexQuotaSnapshot()
    expect(fs.readFileSync).toHaveBeenCalledWith(path.join(path.resolve('test-codex-home'), 'auth.json'), 'utf8')
  })

  it('omits missing, failed, expired, and malformed quota readings', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('missing file') })
    expect(await loadCodexQuotaSnapshot()).toBeUndefined()
    vi.mocked(fs.readFileSync).mockReturnValue(storedAuth())
    fetchMock.mockRejectedValueOnce(new Error('network failed'))
    expect(await loadCodexQuotaSnapshot()).toBeUndefined()
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 })
    expect(await loadCodexQuotaSnapshot()).toBeUndefined()
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
    expect(await loadCodexQuotaSnapshot()).toBeUndefined()
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('invalid JSON') } })
    expect(await loadCodexQuotaSnapshot()).toBeUndefined()
  })
})
