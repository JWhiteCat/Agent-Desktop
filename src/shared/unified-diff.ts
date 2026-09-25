export interface UnifiedDiff {
  text: string
  added: number
  removed: number
}

interface Tagged {
  tag: ' ' | '+' | '-'
  text: string
}

const MAX_CELLS = 1_000_000
const CONTEXT = 3

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Longest-common-subsequence diff. A huge window falls back to a valid delete-then-add patch. */
function lineDiff(a: string[], b: string[]): Tagged[] {
  if (a.length === 0) return b.map((text) => ({ tag: '+', text }))
  if (b.length === 0) return a.map((text) => ({ tag: '-', text }))
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ tag: '-' as const, text })), ...b.map((text) => ({ tag: '+' as const, text }))]
  }
  const n = a.length
  const m = b.length
  const dp = new Int32Array((n + 1) * (m + 1))
  const at = (i: number, j: number) => i * (m + 1) + j
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)])
    }
  }
  const out: Tagged[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ tag: ' ', text: a[i] })
      i++
      j++
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      out.push({ tag: '-', text: a[i] })
      i++
    } else {
      out.push({ tag: '+', text: b[j] })
      j++
    }
  }
  while (i < n) out.push({ tag: '-', text: a[i++] })
  while (j < m) out.push({ tag: '+', text: b[j++] })
  return out
}

function diffLines(a: string[], b: string[]): Tagged[] {
  let start = 0
  const limit = Math.min(a.length, b.length)
  while (start < limit && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const mid = lineDiff(a.slice(start, endA), b.slice(start, endB))
  return [
    ...a.slice(0, start).map((text) => ({ tag: ' ' as const, text })),
    ...mid,
    ...a.slice(endA).map((text) => ({ tag: ' ' as const, text }))
  ]
}

interface Numbered extends Tagged {
  oldNo?: number
  newNo?: number
}

function numberRows(rows: Tagged[]): Numbered[] {
  let oldNo = 1
  let newNo = 1
  return rows.map((row) => {
    if (row.tag === ' ') return { ...row, oldNo: oldNo++, newNo: newNo++ }
    if (row.tag === '-') return { ...row, oldNo: oldNo++ }
    return { ...row, newNo: newNo++ }
  })
}

function hunks(rows: Numbered[]): string[] {
  const changed: number[] = []
  rows.forEach((row, i) => {
    if (row.tag !== ' ') changed.push(i)
  })
  if (!changed.length) return []
  const ranges: Array<[number, number]> = []
  for (const i of changed) {
    const start = Math.max(0, i - CONTEXT)
    const end = Math.min(rows.length, i + CONTEXT + 1)
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  }
  const out: string[] = []
  for (const [start, end] of ranges) {
    const slice = rows.slice(start, end)
    let oldStart = 0
    let newStart = 0
    for (const row of slice) {
      if (!oldStart && row.oldNo) oldStart = row.oldNo
      if (!newStart && row.newNo) newStart = row.newNo
    }
    const oldCount = slice.filter((row) => row.tag !== '+').length
    const newCount = slice.filter((row) => row.tag !== '-').length
    out.push(`@@ -${oldCount ? oldStart : 0},${oldCount} +${newCount ? newStart : 0},${newCount} @@`)
    for (const row of slice) out.push(row.tag === ' ' ? ` ${row.text}` : `${row.tag}${row.text}`)
  }
  return out
}

/** Build a unified diff from the before/after text Cursor ACP sends on an edit. */
export function unifiedDiff(filePath: string, oldText: string | null, newText: string): UnifiedDiff {
  const path = filePath.replace(/\r?\n/g, '') || 'file'
  const oldLines = splitLines(oldText ?? '')
  const newLines = splitLines(newText)
  const body = hunks(numberRows(diffLines(oldLines, newLines)))
  if (!body.length) return { text: '', added: 0, removed: 0 }
  let added = 0
  let removed = 0
  for (const line of body) {
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  const header = [`diff --git a/${path} b/${path}`]
  if (oldText == null) header.push('new file mode 100644', '--- /dev/null', `+++ b/${path}`)
  else if (!newText) header.push('deleted file mode 100644', `--- a/${path}`, '+++ /dev/null')
  else header.push(`--- a/${path}`, `+++ b/${path}`)
  return { text: [...header, ...body].join('\n'), added, removed }
}
