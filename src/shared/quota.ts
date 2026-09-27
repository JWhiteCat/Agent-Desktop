export interface QuotaWindow {
  id: string
  /** Period or row name, such as 5小时, 每周, 每月, or 积分. */
  label: string
  /** Pool name when `label` is a period, such as Cursor 模型. */
  detail?: string
  /** 0–100 and above. Null for an amount-only row such as credits. */
  usedPercent: number | null
  /** Used and limit, already formatted, such as `$12.50 / $20.00`. */
  amount?: string
  /** Unix milliseconds. */
  resetsAt?: number
}

/** Actual tokens and billed total for Cursor's current billing cycle. */
export interface MonthUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** False when the account did not return per-model rows, so the token fields are not a real zero. */
  tokensKnown: boolean
  /** Billed USD. Null when neither per-model cents nor `totalSpend` came back. */
  costUsd: number | null
}

export interface ProviderQuota {
  provider: 'cursor' | 'codex'
  plan?: string
  windows: QuotaWindow[]
  /** Current-cycle tokens and price. Cursor only. */
  monthUsage?: MonthUsage
  /** Why the card is empty, or a warning beside the windows. */
  note?: string
}

export interface QuotaReport {
  cursor: ProviderQuota
  codex: ProviderQuota
}

/** Names a quota window from its length. Unknown lengths stay numeric. */
export function windowLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const hours = seconds / 3600
  const days = hours / 24
  if (hours >= 4 && hours <= 6) return '5小时'
  if (days >= 6 && days <= 8) return '每周'
  if (days >= 27 && days <= 32) return '每月'
  if (hours < 48) return `${Math.round(hours)}小时`
  return `${Math.round(days)}天`
}

export function parseCursorQuota(usage: unknown, plan: unknown): ProviderQuota {
  const usageRec = asRecord(usage)
  const planInfo = asRecord(pick(asRecord(plan), 'planInfo', 'plan_info'))
  const planName = text(pick(planInfo, 'planName', 'plan_name'))
  const planUsage = asRecord(pick(usageRec, 'planUsage', 'plan_usage'))
  const resetsAt = millis(pick(usageRec, 'billingCycleEnd', 'billing_cycle_end')) ?? millis(pick(planInfo, 'billingCycleEnd', 'billing_cycle_end'))
  const windows: QuotaWindow[] = []

  const auto = num(pick(planUsage, 'autoPercentUsed', 'auto_percent_used'))
  if (auto != null) {
    windows.push({ id: 'cursor-models', label: '每月', detail: 'Cursor 模型', usedPercent: auto, resetsAt })
  }

  const api = num(pick(planUsage, 'apiPercentUsed', 'api_percent_used'))
  const other = otherModelsWindow(planUsage, planInfo, api, resetsAt)
  if (other) windows.push(other)

  const spend = spendWindow(asRecord(pick(usageRec, 'spendLimitUsage', 'spend_limit_usage')), resetsAt)
  if (spend) windows.push(spend)

  if (!windows.length) {
    return { provider: 'cursor', plan: planName, windows, note: '没有可用的额度数据' }
  }
  return { provider: 'cursor', plan: planName, windows }
}

/**
 * Current billing cycle from `GetAggregatedUsageEvents`.
 * An empty or failed aggregation still keeps `planUsage.totalSpend` when that price is present.
 */
export function parseCursorMonthUsage(aggregated: unknown, periodUsage: unknown): MonthUsage | undefined {
  const rows = pick(asRecord(aggregated), 'aggregations')
  const list = Array.isArray(rows) ? rows : null
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let costCents: number | null = null
  let tokensKnown = false
  if (list) {
    for (const item of list) {
      const row = asRecord(item)
      if (!row) continue
      tokensKnown = true
      inputTokens += tokenCount(pick(row, 'inputTokens', 'input_tokens'))
      outputTokens += tokenCount(pick(row, 'outputTokens', 'output_tokens'))
      cacheReadTokens += tokenCount(pick(row, 'cacheReadTokens', 'cache_read_tokens'))
      cacheWriteTokens += tokenCount(pick(row, 'cacheWriteTokens', 'cache_write_tokens'))
      const cents = num(pick(row, 'totalCents', 'total_cents'))
      if (cents != null) costCents = (costCents ?? 0) + cents
    }
  }
  if (costCents == null) {
    const planUsage = asRecord(pick(asRecord(periodUsage), 'planUsage', 'plan_usage'))
    const spend = num(pick(planUsage, 'totalSpend', 'total_spend'))
    if (spend != null) costCents = spend
  }
  if (!tokensKnown && costCents == null) return undefined
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    tokensKnown,
    costUsd: costCents == null ? null : costCents / 100
  }
}

export function parseCodexQuota(body: unknown): ProviderQuota {
  const root = asRecord(body)
  const plan = text(pick(root, 'plan_type', 'planType'))
  const windows: QuotaWindow[] = []
  const rate = asRecord(pick(root, 'rate_limit', 'rateLimit'))
  pushWindow(windows, 'primary', pick(rate, 'primary_window', 'primaryWindow'))
  pushWindow(windows, 'secondary', pick(rate, 'secondary_window', 'secondaryWindow'))
  collectAdditional(windows, pick(root, 'additional_rate_limits', 'additionalRateLimits'))

  const credit = creditWindow(asRecord(pick(root, 'credits')))
  if (credit) windows.push(credit)

  if (!windows.length) {
    return { provider: 'codex', plan, windows, note: '没有可用的额度窗口' }
  }
  return { provider: 'codex', plan, windows }
}

function otherModelsWindow(
  planUsage: Record<string, unknown> | null,
  planInfo: Record<string, unknown> | null,
  apiPercent: number | null,
  resetsAt: number | undefined
): QuotaWindow | null {
  const included = num(pick(planUsage, 'includedSpend', 'included_spend'))
  const remaining = num(pick(planUsage, 'remaining'))
  const limit = num(pick(planUsage, 'limit'))
  const planLimit = num(pick(planInfo, 'includedAmountCents', 'included_amount_cents'))
  let amount: string | undefined
  if (limit != null && limit > 0) {
    const usedCents = included ?? (remaining != null ? limit - remaining : null)
    if (usedCents != null) amount = `${usdFromCents(usedCents)} / ${usdFromCents(limit)}`
  } else if (planLimit != null && planLimit > 0 && included != null) {
    amount = `${usdFromCents(included)} / ${usdFromCents(planLimit)}`
  }
  if (apiPercent == null && !amount) return null
  let usedPercent = apiPercent
  if (usedPercent == null && limit != null && limit > 0 && included != null) usedPercent = (included / limit) * 100
  return { id: 'other-models', label: '每月', detail: '其他模型', usedPercent, amount, resetsAt }
}

function spendWindow(spend: Record<string, unknown> | null, resetsAt: number | undefined): QuotaWindow | null {
  const individualLimit = num(pick(spend, 'individualLimit', 'individual_limit'))
  const pooledLimit = num(pick(spend, 'pooledLimit', 'pooled_limit'))
  const pooled = !(individualLimit != null && individualLimit > 0) && pooledLimit != null && pooledLimit > 0
  const limit = pooled ? pooledLimit : individualLimit
  if (limit == null || limit <= 0) return null
  const used = (pooled ? num(pick(spend, 'pooledUsed', 'pooled_used')) : num(pick(spend, 'individualUsed', 'individual_used'))) ?? 0
  return {
    id: pooled ? 'on-demand-pooled' : 'on-demand',
    label: '每月',
    detail: '按需支出',
    usedPercent: (used / limit) * 100,
    amount: `${usdFromCents(used)} / ${usdFromCents(limit)}`,
    resetsAt
  }
}

function pushWindow(out: QuotaWindow[], id: string, raw: unknown, detail?: string): void {
  const row = quotaWindow(id, raw, detail)
  if (row) out.push(row)
}

function quotaWindow(id: string, raw: unknown, detail?: string): QuotaWindow | null {
  const win = asRecord(raw)
  if (!win) return null
  const used = num(pick(win, 'used_percent', 'usedPercent'))
  const seconds = num(pick(win, 'limit_window_seconds', 'limitWindowSeconds'))
  if (used == null || seconds == null || seconds <= 0) return null
  const label = windowLabel(seconds)
  if (!label) return null
  const reset = num(pick(win, 'reset_at', 'resetAt'))
  const name = detail?.trim()
  return {
    id,
    label,
    detail: name || undefined,
    usedPercent: used,
    resetsAt: reset != null && reset > 0 ? (reset < 1e12 ? reset * 1000 : reset) : undefined
  }
}

function collectAdditional(out: QuotaWindow[], raw: unknown): void {
  if (raw == null) return
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => collectExtraItem(out, item, `extra-${index}`))
    return
  }
  const rec = asRecord(raw)
  if (!rec) return
  if (num(pick(rec, 'used_percent', 'usedPercent')) != null) {
    pushWindow(out, 'extra', rec)
    return
  }
  if (rec.primary_window || rec.primaryWindow || rec.secondary_window || rec.secondaryWindow || rec.rate_limit || rec.rateLimit) {
    collectExtraItem(out, rec, 'extra')
    return
  }
  for (const [key, value] of Object.entries(rec)) {
    collectExtraItem(out, value, `extra-${key}`, key.replace(/_/g, ' '))
  }
}

function collectExtraItem(out: QuotaWindow[], item: unknown, id: string, name?: string): void {
  const rec = asRecord(item)
  if (!rec) return
  const nested = asRecord(pick(rec, 'rate_limit', 'rateLimit'))
  const label = text(pick(rec, 'name', 'limit_name', 'limitName')) || name
  const before = out.length
  pushWindow(out, `${id}-primary`, pick(rec, 'primary_window', 'primaryWindow') ?? pick(nested, 'primary_window', 'primaryWindow'), label)
  pushWindow(out, `${id}-secondary`, pick(rec, 'secondary_window', 'secondaryWindow') ?? pick(nested, 'secondary_window', 'secondaryWindow'), label)
  if (out.length === before) pushWindow(out, id, rec, label)
}

function creditWindow(credits: Record<string, unknown> | null): QuotaWindow | null {
  if (!credits) return null
  const amount = credits.unlimited === true ? '不限' : creditAmount(credits.balance)
  if (!amount) return null
  return { id: 'credits', label: '积分', usedPercent: null, amount }
}

function creditAmount(balance: unknown): string | null {
  if (typeof balance === 'number' && Number.isFinite(balance) && balance > 0) return usd(balance)
  if (typeof balance !== 'string') return null
  const textValue = balance.trim()
  if (!textValue) return null
  if (textValue.startsWith('$')) {
    const n = Number(textValue.slice(1))
    return Number.isFinite(n) && n > 0 ? textValue : null
  }
  const n = Number(textValue)
  if (!Number.isFinite(n) || n <= 0) return null
  return usd(n)
}

function usdFromCents(cents: number): string {
  return usd(cents / 100)
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`
}

function millis(value: unknown): number | undefined {
  const n = num(value)
  if (n == null || n <= 0) return undefined
  return n < 1e12 ? n * 1000 : n
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function pick(rec: Record<string, unknown> | null, ...keys: string[]): unknown {
  if (!rec) return undefined
  for (const key of keys) {
    const value = rec[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function tokenCount(value: unknown): number {
  const n = num(value)
  return n != null && n > 0 ? n : 0
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}
