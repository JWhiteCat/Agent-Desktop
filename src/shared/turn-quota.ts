import { antigravityQuotaGroup, type ProviderQuota, type QuotaWindow } from './quota'

const RESET_TIME_TOLERANCE_MS = 1_000

/** Legacy stored account-quota deltas; retained only to read older session events. */
export interface TurnQuotaUsage {
  weekly?: number
  fiveHour?: number
}

/** Account quota observed during this turn; it includes usage from other sessions. */
export interface TurnQuotaSnapshot {
  sampledAt: number
  weekly?: { usedPercent: number; resetsAt?: number }
  fiveHour?: { usedPercent: number; resetsAt?: number }
}

/** Fixed account readings around one turn; the difference can include other sessions. */
export interface WeeklyQuotaEstimate {
  start?: TurnQuotaSnapshot
  end?: TurnQuotaSnapshot
  usedPercent?: number
}

export function weeklyQuotaEstimate(start?: TurnQuotaSnapshot, end?: TurnQuotaSnapshot): WeeklyQuotaEstimate {
  const estimate: WeeklyQuotaEstimate = { start, end }
  const startWindow = start?.weekly
  const endWindow = end?.weekly
  if (!start || !end || !startWindow || !endWindow ||
    !Number.isFinite(start.sampledAt) || !Number.isFinite(end.sampledAt) || start.sampledAt > end.sampledAt ||
    !validPercent(startWindow.usedPercent) || !validPercent(endWindow.usedPercent)) return estimate
  const startReset = startWindow.resetsAt
  const endReset = endWindow.resetsAt
  // Account reads can differ by one second when reporting the same reset time.
  // An unused rolling window (0% used at start) can also anchor its reset time when the turn begins.
  const resetDrift = endReset != null && startReset != null ? endReset - startReset : NaN
  const maxForwardDrift = startWindow.usedPercent === 0
    ? (end.sampledAt - start.sampledAt) + RESET_TIME_TOLERANCE_MS
    : RESET_TIME_TOLERANCE_MS
  if (startReset == null || !Number.isFinite(startReset) || startReset <= 0 ||
    endReset == null || !Number.isFinite(endReset) || endReset <= 0 ||
    resetDrift < -RESET_TIME_TOLERANCE_MS || resetDrift > maxForwardDrift ||
    Math.min(startReset, endReset) <= end.sampledAt) return estimate
  const difference = endWindow.usedPercent - startWindow.usedPercent
  if (Number.isFinite(difference) && difference >= 0) estimate.usedPercent = difference
  return estimate
}

/** Keep the account's main windows without interpreting their changes as turn usage. */
export function quotaSnapshot(quota: ProviderQuota, sampledAt: number, model?: string): TurnQuotaSnapshot | undefined {
  if ((quota.provider !== 'codex' && quota.provider !== 'antigravity') || !Number.isFinite(sampledAt)) return undefined
  const snapshot: TurnQuotaSnapshot = { sampledAt }
  for (const [key, label] of [['weekly', '每周'], ['fiveHour', '5小时']] as const) {
    const window = quota.provider === 'codex'
      ? mainWindow(quota, label)
      : antigravityWindow(quota, label, model)
    if (!window || !validPercent(window.usedPercent)) continue
    const resetsAt = window.resetsAt != null && Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : undefined
    snapshot[key] = { usedPercent: window.usedPercent, resetsAt }
  }
  return snapshot.weekly || snapshot.fiveHour ? snapshot : undefined
}

function mainWindow(quota: ProviderQuota, label: string): QuotaWindow | undefined {
  const matches = quota.windows.filter((window) => (window.id === 'primary' || window.id === 'secondary') && window.label === label)
  return matches.length === 1 ? matches[0] : undefined
}

function antigravityWindow(quota: ProviderQuota, label: string, model?: string): QuotaWindow | undefined {
  const group = antigravityQuotaGroup(model)
  if (group) {
    const bucketId = label === '每周' ? `${group}-weekly` : `${group}-5h`
    const byId = quota.windows.filter((window) => window.id === bucketId)
    if (byId.length === 1) return byId[0]
    const detail = group === 'gemini' ? 'Gemini 模型' : 'Claude 和 GPT 模型'
    const byDetail = quota.windows.filter((window) => window.detail === detail && window.label === label)
    return byDetail.length === 1 ? byDetail[0] : undefined
  }
  const matches = quota.windows.filter((window) => window.label === label && validPercent(window.usedPercent))
  return matches.length === 1 ? matches[0] : undefined
}

function validPercent(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value >= 0
}
