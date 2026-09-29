import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCodexQuota, loadQuotas } from '../src/main/quota'

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

describe('Codex settings quota', () => {
  it('reads the account quota with authenticated headers and the settings timeout', async () => {
    const signal = new AbortController().signal
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
    const report = await loadQuotas(undefined, undefined)
    expect(report.codex.windows).toHaveLength(2)
    expect(JSON.stringify(report)).not.toContain('test-access-token')
    expect(JSON.stringify(report)).not.toContain('account-test')
    expect(timeout).toHaveBeenCalledWith(15_000)
    expect(fetchMock).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', {
      headers: { Authorization: 'Bearer test-access-token', 'ChatGPT-Account-Id': 'account-test' },
      signal
    })
  })

  it('authenticates with the access token when no account ID is available', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ tokens: { access_token: 'test-access-token' } }))
    const report = await loadQuotas(undefined, undefined)
    expect(report.codex.windows).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', expect.objectContaining({
      headers: { Authorization: 'Bearer test-access-token' }
    }))
  })

  it.each(['settings', 'CODEX_API_KEY', 'OPENAI_API_KEY'])('prefers %s API keys over stored ChatGPT tokens', async (source) => {
    const settings = source === 'settings' ? 'configured-api-key' : undefined
    if (source !== 'settings') vi.stubEnv(source, 'environment-api-key')
    expect((await loadQuotas(undefined, settings)).codex.note).toContain('API Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([{ auth_mode: 'apikey' }, { OPENAI_API_KEY: 'stored-api-key' }])('respects stored API key auth despite leftover tokens: %j', async (auth) => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ...auth, tokens: { access_token: 'old-token' } }))
    expect((await loadQuotas(undefined, undefined)).codex.note).toContain('API Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the auth file from CODEX_HOME when configured', async () => {
    vi.stubEnv('CODEX_HOME', path.resolve('test-codex-home'))
    await loadQuotas(undefined, undefined)
    expect(fs.readFileSync).toHaveBeenCalledWith(path.join(path.resolve('test-codex-home'), 'auth.json'), 'utf8')
  })

  it('reports missing authentication and network failures without inventing quota windows', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('missing file') })
    expect((await loadQuotas(undefined, undefined)).codex).toMatchObject({ windows: [], note: '未登录 Codex。请使用 ChatGPT 登录。' })
    vi.mocked(fs.readFileSync).mockReturnValue(storedAuth())
    fetchMock.mockRejectedValueOnce(new Error('network failed'))
    expect((await loadQuotas(undefined, undefined)).codex).toMatchObject({ windows: [], note: '暂时无法获取 Codex 额度' })
  })

  it.each([401, 403])('reports expired authentication for HTTP %i', async (status) => {
    fetchMock.mockResolvedValueOnce({ ok: false, status })
    expect((await loadQuotas(undefined, undefined)).codex).toMatchObject({ windows: [], note: 'Codex 登录已过期，请重新登录' })
  })

  it('reports other HTTP failures and malformed quota responses', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 })
    expect((await loadQuotas(undefined, undefined)).codex).toMatchObject({ windows: [], note: '暂时无法获取 Codex 额度（HTTP 503）' })
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
    expect((await loadQuotas(undefined, undefined)).codex).toMatchObject({ windows: [], note: '没有可用的额度窗口' })
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('invalid JSON') } })
    expect((await loadQuotas(undefined, undefined)).codex).toMatchObject({ windows: [], note: '没有可用的额度窗口' })
  })
})

describe('Codex turn quota snapshot', () => {
  it('reads only Codex quota with the configured turn timeout', async () => {
    const signal = new AbortController().signal
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
    const quota = await loadCodexQuota(undefined, 3_000)
    expect(quota.windows).toHaveLength(2)
    expect(timeout).toHaveBeenCalledExactlyOnceWith(3_000)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://chatgpt.com/backend-api/wham/usage', {
      headers: { Authorization: 'Bearer test-access-token', 'ChatGPT-Account-Id': 'account-test' },
      signal
    })
  })

  it('keeps the settings timeout when no override is supplied', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    await loadCodexQuota(undefined)
    expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000)
  })

  it('reports timed out snapshots without rejecting the caller', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    await expect(loadCodexQuota(undefined, 3_000)).resolves.toMatchObject({
      provider: 'codex', windows: [], note: '暂时无法获取 Codex 额度'
    })
  })
})
