import type { ProviderQuota, QuotaWindow } from './quota'

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
  if (startReset == null || !Number.isFinite(startReset) || startReset <= 0 ||
    endReset == null || !Number.isFinite(endReset) || endReset <= 0 ||
    Math.abs(startReset - endReset) > RESET_TIME_TOLERANCE_MS ||
    Math.min(startReset, endReset) <= end.sampledAt) return estimate
  const difference = endWindow.usedPercent - startWindow.usedPercent
  if (Number.isFinite(difference) && difference >= 0) estimate.usedPercent = difference
  return estimate
}

/** Keep the account's main windows without interpreting their changes as turn usage. */
export function quotaSnapshot(quota: ProviderQuota, sampledAt: number): TurnQuotaSnapshot | undefined {
  if (quota.provider !== 'codex' || !Number.isFinite(sampledAt)) return undefined
  const snapshot: TurnQuotaSnapshot = { sampledAt }
  for (const [key, label] of [['weekly', '每周'], ['fiveHour', '5小时']] as const) {
    const window = mainWindow(quota, label)
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

function validPercent(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value >= 0
}
