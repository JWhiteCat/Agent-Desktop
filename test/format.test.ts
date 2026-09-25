import { describe, expect, it } from 'vitest'
import { titleFrom } from '../src/main/sessions'
import { parseUnifiedDiff } from '../src/renderer/src/lib/diff'
import { basename, duration, relativePath, relativeTime, shortPath } from '../src/renderer/src/lib/format'
import { summarizeTool } from '../src/renderer/src/lib/tools'
import type { ToolItem } from '../src/shared/types'

describe('format', () => {
  const now = Date.UTC(2026, 8, 25, 8, 0, 0)

  it('formats relative time and duration', () => {
    expect(relativeTime(now, now)).toBe('刚刚')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分钟')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 小时')
    expect(duration(500)).toBe('500ms')
    expect(duration(1500)).toBe('2s')
    expect(duration(65_000)).toBe('1m 5s')
  })

  it('shortens paths relative to a project root', () => {
    expect(basename('C:\\proj\\src\\cli.ts')).toBe('cli.ts')
    expect(relativePath('C:\\proj\\src\\cli.ts', 'c:\\proj')).toBe('src/cli.ts')
    expect(shortPath('C:/a/b/c/d.ts')).toBe('…/c/d.ts')
  })
})

describe('tools and diffs', () => {
  it('summarizes a read and parses a unified diff', () => {
    const item: ToolItem = {
      id: '1',
      kind: 'tool',
      callId: 'c',
      tool: 'read',
      args: { path: 'src/main/cli.ts' },
      status: 'success',
      startedAt: 1,
      result: { success: { readRange: { startLine: 1, endLine: 4 } } }
    }
    expect(summarizeTool(item)).toMatchObject({ kind: 'read', verb: '已读取', target: 'cli.ts', meta: 'L1-4' })

    const files = parseUnifiedDiff(
      ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new', ''].join('\n')
    )
    expect(files).toEqual([
      { path: 'a.ts', lines: ['@@ -1 +1 @@', '-old', '+new'], added: 1, removed: 1 }
    ])
  })
})

describe('titleFrom', () => {
  it('uses the first line and caps the length', () => {
    expect(titleFrom('\n修复测试\n细节')).toBe('修复测试')
    expect(titleFrom('a'.repeat(49))).toBe(`${'a'.repeat(48)}…`)
  })
})
