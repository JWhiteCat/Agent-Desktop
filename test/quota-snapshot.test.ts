import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeCodexReset, loadCodexQuota, loadProviderQuota, loadQuotas } from '../src/main/quota'

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
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (String(url).includes('/rate-limit-reset-credits')) {
      return { ok: true, status: 200, json: async () => ({ credits: [] }) }
    }
    return { ok: true, status: 200, json: async () => usage }
  })
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
    expect(report.codex.resetCredits).toEqual([])
    expect(JSON.stringify(report)).not.toContain('test-access-token')
    expect(JSON.stringify(report)).not.toContain('account-test')
    expect(timeout).toHaveBeenCalledWith(15_000)
    const headers = { Authorization: 'Bearer test-access-token', 'ChatGPT-Account-Id': 'account-test' }
    expect(fetchMock).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', { headers, signal })
    expect(fetchMock).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', { headers, signal })
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
    const codex = (await loadQuotas(undefined, undefined)).codex
    expect(codex).toMatchObject({ windows: [], note: 'Codex 登录已过期，请重新登录' })
    expect(codex.resetCredits).toBeUndefined()
    // The parallel detail request must not expose cards for expired authentication.
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/rate-limit-reset-credits'), expect.anything())
  })

  it('keeps quota windows when reset-card details fail', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/rate-limit-reset-credits')) return { ok: false, status: 503, json: async () => ({ message: 'down' }) }
      return { ok: true, status: 200, json: async () => usage }
    })
    const codex = (await loadQuotas(undefined, undefined)).codex
    expect(codex.windows).toHaveLength(2)
    expect(codex.resetCredits).toBeNull()
  })

  it('attaches reset cards returned beside the quota windows', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/rate-limit-reset-credits')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            credits: [{ id: 'credit-1', status: 'available', title: 'Full reset', expires_at: '2026-10-17T00:00:00Z' }]
          })
        }
      }
      return { ok: true, status: 200, json: async () => usage }
    })
    const codex = (await loadQuotas(undefined, undefined)).codex
    expect(codex.windows).toHaveLength(2)
    expect(codex.resetCredits).toEqual([
      { id: 'credit-1', status: 'available', title: 'Full reset', expiresAt: Date.parse('2026-10-17T00:00:00Z') }
    ])
  })

  it('reports other HTTP failures and malformed quota responses', async () => {
    const credits = { ok: true, status: 200, json: async () => ({ credits: [] }) }
    fetchMock.mockImplementation(async (url: string) => (
      String(url).includes('/rate-limit-reset-credits') ? credits : { ok: false, status: 503, json: async () => null }
    ))
    expect((await loadQuotas(undefined, undefined)).codex).toMatchObject({ windows: [], note: '暂时无法获取 Codex 额度（HTTP 503）' })
    fetchMock.mockImplementation(async (url: string) => (
      String(url).includes('/rate-limit-reset-credits') ? credits : { ok: true, status: 200, json: async () => ({}) }
    ))
    expect((await loadQuotas(undefined, undefined)).codex).toMatchObject({ windows: [], note: '没有可用的额度窗口' })
    fetchMock.mockImplementation(async (url: string) => (
      String(url).includes('/rate-limit-reset-credits') ? credits : { ok: true, status: 200, json: async () => { throw new Error('invalid JSON') } }
    ))
    expect((await loadQuotas(undefined, undefined)).codex).toMatchObject({ windows: [], note: '没有可用的额度窗口' })
  })
})

describe('settings quota latency', () => {
  it('returns Codex while Cursor authentication is still pending', async () => {
    let finishExchange!: (value: unknown) => void
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/exchange_user_api_key')) return new Promise((resolve) => { finishExchange = resolve })
      return Promise.resolve({ ok: true, status: 200, json: async () => url.includes('/rate-limit-reset-credits') ? { credits: [] } : usage })
    })
    const cursor = loadProviderQuota('cursor', 'latency-test-key')
    try {
      const codex = await loadProviderQuota('codex', undefined)
      expect(codex.windows).toHaveLength(2)
      expect(codex.resetCredits).toEqual([])
    } finally {
      finishExchange({ ok: false, status: 401 })
      await cursor
    }
  })

  it('starts reset-card retrieval before the quota response arrives', async () => {
    let finishUsage!: (value: unknown) => void
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/usage')) return new Promise((resolve) => { finishUsage = resolve })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ credits: [] }) })
    })
    const pending = loadProviderQuota('codex', undefined)
    try {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/rate-limit-reset-credits'), expect.anything())
    } finally {
      finishUsage({ ok: true, status: 200, json: async () => usage })
    }
    expect((await pending).windows).toHaveLength(2)
  })

  it('keeps Cursor quota when optional plan and token details time out', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ accessToken: 'cursor-token' }))
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/GetCurrentPeriodUsage')) {
        return { ok: true, status: 200, json: async () => ({ planUsage: { autoPercentUsed: 25 } }) }
      }
      throw new Error('detail timeout')
    })
    const quota = await loadProviderQuota('cursor', undefined)
    expect(quota.windows[0]).toMatchObject({ usedPercent: 25 })
    expect(quota.note).toBeUndefined()
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([15_000, 3_000, 3_000])
  })

  it('limits reset-card waiting to three seconds without shortening the quota timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    await loadProviderQuota('codex', undefined)
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([15_000, 3_000])
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

  it('posts one consume request and does not retry', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 'reset' }) })
    await consumeCodexReset(undefined, ' credit-1 ')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }]
    expect(url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer test-access-token')
    expect(init.headers['ChatGPT-Account-Id']).toBe('account-test')
    expect(JSON.parse(init.body)).toEqual({
      credit_id: 'credit-1',
      redeem_request_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    })
  })

  it('reports consume failure without the access token', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: 'already used test-access-token' }) })
    await expect(consumeCodexReset(undefined, 'credit-1')).rejects.toThrow('暂时无法使用重置卡（HTTP 409）')
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: 'already redeemed' }) })
    await expect(consumeCodexReset(undefined, 'credit-1')).rejects.toThrow('暂时无法使用重置卡（HTTP 409）：already redeemed')
  })

  it('does not redeem when the id is blank, the login is an API key, or the network fails', async () => {
    await expect(consumeCodexReset(undefined, '  ')).rejects.toThrow('找不到这张重置卡')
    await expect(consumeCodexReset('configured-api-key', 'credit-1')).rejects.toThrow('API Key')
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockRejectedValue(new Error('network failed'))
    await expect(consumeCodexReset(undefined, 'credit-1')).rejects.toThrow(/^暂时无法使用重置卡$/)
  })

  it('reports timed out snapshots without rejecting the caller', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    await expect(loadCodexQuota(undefined, 3_000)).resolves.toMatchObject({
      provider: 'codex', windows: [], note: '暂时无法获取 Codex 额度'
    })
  })
})
