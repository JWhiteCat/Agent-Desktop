import type { ProviderQuota, QuotaWindow } from './quota'

/** Account usage increases in percentage points during a Codex turn. */
export interface TurnQuotaUsage {
  weekly?: number
  fiveHour?: number
}

/** Compare the account's main windows only when both snapshots describe the same period. */
export function quotaDelta(before: ProviderQuota, after: ProviderQuota, startedAt: number, finishedAt: number): TurnQuotaUsage | undefined {
  if (before.provider !== 'codex' || after.provider !== 'codex') return undefined
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return undefined

  const usage: TurnQuotaUsage = {}
  for (const [key, label] of [['weekly', '每周'], ['fiveHour', '5小时']] as const) {
    const start = mainWindow(before, label)
    const end = mainWindow(after, label)
    if (!start || !end || start.id !== end.id) continue
    const reset = start.resetsAt
    if (reset == null || !Number.isFinite(reset) || reset !== end.resetsAt || reset <= finishedAt) continue
    if (!validPercent(start.usedPercent) || !validPercent(end.usedPercent) || end.usedPercent < start.usedPercent) continue
    const delta = end.usedPercent - start.usedPercent
    if (Number.isFinite(delta)) usage[key] = delta
  }
  return Object.keys(usage).length ? usage : undefined
}

function mainWindow(quota: ProviderQuota, label: string): QuotaWindow | undefined {
  const matches = quota.windows.filter((window) => (window.id === 'primary' || window.id === 'secondary') && window.label === label)
  return matches.length === 1 ? matches[0] : undefined
}

function validPercent(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value >= 0
}
