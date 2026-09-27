/** How long until a quota window resets. */
export function resetsIn(ts: number, now = Date.now()): string {
  const diff = ts - now
  if (diff <= 0) return '即将重置'
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '1 分钟内'
  if (min < 60) return `${min} 分钟后`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时后`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} 天后`
  if (d < 30) return `${Math.floor(d / 7)} 周后`
  return `${Math.floor(d / 30)} 个月后`
}

export function resetStamp(ts: number): string {
  const date = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} 天`
  if (d < 30) return `${Math.floor(d / 7)} 周`
  const date = new Date(ts)
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

export function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** List-price estimate. Null means the model has no published price. */
export function formatUsd(cost: number | null): string {
  if (cost == null) return '未定价'
  if (cost === 0) return '$0'
  if (cost < 0.01) {
    const text = cost.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
    return text === '0' ? '<$0.0001' : `$${text}`
  }
  return `$${cost.toFixed(2)}`
}

export function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

export function relativePath(p: string, root?: string): string {
  if (!root) return p
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const a = norm(p)
  const b = norm(root)
  if (a.toLowerCase().startsWith(b.toLowerCase() + '/')) return a.slice(b.length + 1)
  return p
}

export function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : p
}
