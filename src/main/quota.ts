import { t as translate } from '@shared/i18n'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { net } from 'electron'
import { applyCursorMonthUsage, parseCodexQuota, parseCodexResetCredits, parseCursorQuota, type CodexResetCredit, type ProviderQuota, type QuotaReport } from '@shared/quota'
import { resolveApiKey } from './cli'
import { resolveCodexApiKey } from './codex'

const CURSOR_API = 'https://api2.cursor.sh'
const CODEX_USAGE = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_RESET_CREDITS = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const FETCH_MS = 15_000
const EXPIRED_NOTE = () => translate('Codex 登录已过期，请重新登录')

/** Chromium's network stack follows the system proxy. Node's fetch does not. */
const http: typeof net.fetch = (...args) => net.fetch(...args)

/** In-memory only. The API key itself is not stored here. */
let cursorTokenCache: { keyId: string; accessToken: string; exp: number } | null = null

/** Reads account quota for both CLIs. Access tokens never leave this process. */
export async function loadQuotas(cursorApiKey: string | undefined, codexApiKey: string | undefined): Promise<QuotaReport> {
  const [cursor, codex] = await Promise.all([loadCursorQuota(cursorApiKey), loadCodexSettingsQuota(codexApiKey)])
  return { cursor, codex }
}

async function loadCursorQuota(apiKeySetting: string | undefined): Promise<ProviderQuota> {
  try {
    const token = await cursorAccessToken(apiKeySetting)
    if (!token.ok) return { provider: 'cursor', windows: [], note: token.note }
    const headers = {
      Authorization: `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1'
    }
    const [usage, plan, aggregated] = await Promise.all([
      postJson(`${CURSOR_API}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, headers),
      postJson(`${CURSOR_API}/aiserver.v1.DashboardService/GetPlanInfo`, headers),
      postJson(`${CURSOR_API}/aiserver.v1.DashboardService/GetAggregatedUsageEvents`, headers).catch(() => ({
        ok: false,
        status: 0,
        json: null
      }))
    ])
    if (usage.status === 401 || usage.status === 403) {
      cursorTokenCache = null
      return { provider: 'cursor', windows: [], note: translate('Cursor 登录已过期，请重新登录') }
    }
    if (!usage.ok) return { provider: 'cursor', windows: [], note: translate('暂时无法获取 Cursor 额度（HTTP {status}）', { status: usage.status }) }
    const quota = parseCursorQuota(usage.json, plan.ok ? plan.json : undefined)
    applyCursorMonthUsage(quota, aggregated.ok ? aggregated.json : null, usage.json)
    return quota
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (message.startsWith('Cursor ')) return { provider: 'cursor', windows: [], note: message }
    return { provider: 'cursor', windows: [], note: translate('暂时无法获取 Cursor 额度') }
  }
}

export async function loadCodexQuota(apiKeySetting: string | undefined, timeoutMs = FETCH_MS): Promise<ProviderQuota> {
  const auth = codexAuth(apiKeySetting)
  if ('quota' in auth) return auth.quota
  return readCodexUsage(auth.headers, timeoutMs)
}

/** Settings quota includes reset cards. Turn snapshots keep using `loadCodexQuota`. */
async function loadCodexSettingsQuota(apiKeySetting: string | undefined): Promise<ProviderQuota> {
  const auth = codexAuth(apiKeySetting)
  if ('quota' in auth) return auth.quota
  const quota = await readCodexUsage(auth.headers, FETCH_MS)
  if (quota.note === EXPIRED_NOTE()) return quota
  return { ...quota, resetCredits: await readCodexResetCredits(auth.headers) }
}

/** Redeems one reset card. A new request id is used once and never retried. */
export async function consumeCodexReset(apiKeySetting: string | undefined, creditId: string): Promise<void> {
  const id = creditId.trim()
  if (!id) throw new Error(translate('找不到这张重置卡'))
  const auth = codexAuth(apiKeySetting)
  if ('quota' in auth) throw new Error(auth.quota.note || translate('未登录 Codex。请使用 ChatGPT 登录。'))
  const redeemRequestId = randomUUID()
  let res: Response
  try {
    res = await http(`${CODEX_RESET_CREDITS}/consume`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ credit_id: id, redeem_request_id: redeemRequestId }),
      signal: AbortSignal.timeout(FETCH_MS)
    })
  } catch {
    throw new Error(translate('暂时无法使用重置卡'))
  }
  if (res.status === 401 || res.status === 403) throw new Error(EXPIRED_NOTE())
  if (!res.ok) {
    const detail = publicDetail(await errorDetail(res), auth.headers.Authorization)
    throw new Error(detail
      ? translate('暂时无法使用重置卡（HTTP {status}）：{detail}', { status: res.status, detail })
      : translate('暂时无法使用重置卡（HTTP {status}）', { status: res.status }))
  }
}

function codexAuth(apiKeySetting: string | undefined): { headers: Record<string, string> } | { quota: ProviderQuota } {
  const empty = (note: string): { quota: ProviderQuota } => ({ quota: { provider: 'codex', windows: [], note } })
  // ACP explicitly authenticates with this key, even when ChatGPT tokens remain on disk.
  if (resolveCodexApiKey(apiKeySetting)) return empty(translate('当前使用 API Key，没有 ChatGPT 订阅额度'))
  const auth = readCodexAuth()
  if (auth.kind === 'missing') return empty(translate('未登录 Codex。请使用 ChatGPT 登录。'))
  if (auth.kind === 'api-key') return empty(translate('当前使用 API Key，没有 ChatGPT 订阅额度'))
  const headers: Record<string, string> = { Authorization: `Bearer ${auth.token}` }
  if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId
  return { headers }
}

async function readCodexUsage(headers: Record<string, string>, timeoutMs: number): Promise<ProviderQuota> {
  const empty = (note: string): ProviderQuota => ({ provider: 'codex', windows: [], note })
  try {
    const res = await http(CODEX_USAGE, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (res.status === 401 || res.status === 403) return empty(EXPIRED_NOTE())
    if (!res.ok) return empty(translate('暂时无法获取 Codex 额度（HTTP {status}）', { status: res.status }))
    const json = (await res.json().catch(() => null)) as unknown
    return parseCodexQuota(json)
  } catch {
    return empty(translate('暂时无法获取 Codex 额度'))
  }
}

async function readCodexResetCredits(headers: Record<string, string>): Promise<CodexResetCredit[] | null> {
  try {
    const res = await http(CODEX_RESET_CREDITS, { headers, signal: AbortSignal.timeout(FETCH_MS) })
    if (!res.ok) return null
    const json = (await res.json().catch(() => null)) as unknown
    return parseCodexResetCredits(json)
  } catch {
    return null
  }
}

async function errorDetail(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as unknown
  const rec = json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : null
  const nested = rec?.error && typeof rec.error === 'object' && !Array.isArray(rec.error) ? rec.error as Record<string, unknown> : null
  for (const value of [rec?.message, rec?.detail, nested?.message]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function publicDetail(detail: string, authorization: string): string {
  const token = authorization.replace(/^Bearer\s+/i, '')
  if (!detail || detail.includes(token) || /bearer|access_token|sk-/i.test(detail)) return ''
  return detail.slice(0, 180)
}

async function cursorAccessToken(apiKeySetting: string | undefined): Promise<{ ok: true; accessToken: string } | { ok: false; note: string }> {
  const apiKey = resolveApiKey(apiKeySetting)
  if (apiKey) return { ok: true, accessToken: await exchangeCursorKey(apiKey) }
  const stored = readCursorFileToken()
  if (stored === 'expired') return { ok: false, note: translate('Cursor 登录已过期，请重新登录') }
  if (!stored) return { ok: false, note: translate('未登录 Cursor。请填写 API Key，或使用 agent login。') }
  return { ok: true, accessToken: stored }
}

async function exchangeCursorKey(apiKey: string): Promise<string> {
  const keyId = createHash('sha256').update(apiKey).digest('hex')
  const now = Date.now()
  if (cursorTokenCache && cursorTokenCache.keyId === keyId && cursorTokenCache.exp - now > 5 * 60_000) {
    return cursorTokenCache.accessToken
  }
  const res = await http(`${CURSOR_API}/auth/exchange_user_api_key`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(FETCH_MS)
  })
  if (res.status === 401 || res.status === 403) throw new Error(translate('Cursor API Key 无效'))
  if (!res.ok) throw new Error(translate('Cursor 登录失败（HTTP {status}）', { status: res.status }))
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const accessToken = stringField(body, 'accessToken', 'access_token')
  if (!accessToken) throw new Error(translate('Cursor 没有返回登录令牌'))
  const exp = jwtExpMs(accessToken) ?? now + 50 * 60_000
  cursorTokenCache = { keyId, accessToken, exp }
  return accessToken
}

function readCursorFileToken(): string | 'expired' | null {
  let expired = false
  for (const file of cursorAuthPaths()) {
    const token = stringField(asRecord(readJson(file)), 'accessToken', 'access_token')
    if (!token) continue
    if (!tokenFresh(token)) {
      expired = true
      continue
    }
    return token
  }
  return expired ? 'expired' : null
}

function cursorAuthPaths(): string[] {
  const home = os.homedir()
  const paths = [path.join(home, '.cursor', 'auth.json'), path.join(home, '.config', 'cursor', 'auth.json')]
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    paths.unshift(path.join(appData, 'Cursor', 'auth.json'))
  }
  return paths
}

type CodexAuth = { kind: 'token'; token: string; accountId?: string } | { kind: 'api-key' } | { kind: 'missing' }

export function readCodexAuth(): CodexAuth {
  const file = path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'), 'auth.json')
  const root = asRecord(readJson(file))
  if (!root) return { kind: 'missing' }
  if (stringField(root, 'auth_mode', 'authMode') === 'apikey' || stringField(root, 'OPENAI_API_KEY')) return { kind: 'api-key' }
  const tokens = asRecord(root.tokens)
  const token = stringField(root, 'access_token', 'accessToken') || stringField(tokens, 'access_token', 'accessToken')
  if (!token) {
    return { kind: 'missing' }
  }
  const accountId =
    stringField(root, 'account_id', 'accountId', 'chatgpt_account_id') ||
    stringField(tokens, 'account_id', 'accountId', 'chatgpt_account_id')
  return { kind: 'token', token, accountId: accountId || undefined }
}

function tokenFresh(token: string): boolean {
  const exp = jwtExpMs(token)
  if (exp == null) return true
  return exp > Date.now()
}

function jwtExpMs(token: string): number | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof json.exp === 'number' && Number.isFinite(json.exp) ? json.exp * 1000 : null
  } catch {
    return null
  }
}

async function postJson(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await http(url, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(FETCH_MS) })
  const json = (await res.json().catch(() => null)) as unknown
  return { ok: res.ok, status: res.status, json }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stringField(rec: Record<string, unknown> | null, ...keys: string[]): string {
  if (!rec) return ''
  for (const key of keys) {
    const value = rec[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}
