import { describe, expect, it } from 'vitest'
import { titleFrom } from '../src/main/sessions'
import { collectEditedFiles, parseUnifiedDiff } from '../src/renderer/src/lib/diff'
import { basename, duration, relativePath, relativeTime, shortPath } from '../src/renderer/src/lib/format'
import { planPath, planUriOf, summarizeTool, toolDiff } from '../src/renderer/src/lib/tools'
import { unifiedDiff } from '../src/shared/unified-diff'
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

    const created: ToolItem = { ...item, tool: 'edit', args: { path: 'src/new.ts' }, result: { success: { linesRemoved: 0, diffString: 'diff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n' } } }
    expect(summarizeTool(created)).toMatchObject({ verb: '已创建', target: 'new.ts' })
  })

  it('builds a contextual unified diff and groups a turn by file', () => {
    const built = unifiedDiff('src/a.ts', 'keep\nold\n', 'keep\nnew\n')
    expect(built.added).toBe(1)
    expect(built.removed).toBe(1)
    expect(parseUnifiedDiff(built.text)[0]).toMatchObject({ path: 'src/a.ts', added: 1, removed: 1 })

    const edit: ToolItem = {
      id: 'e',
      kind: 'tool',
      callId: 'c',
      tool: 'edit',
      args: { path: 'C:\\proj\\src\\a.ts', old_string: 'old', new_string: 'new' },
      status: 'success',
      startedAt: 1
    }
    expect(toolDiff(edit)).toContain('-old')
    const files = collectEditedFiles([edit, { ...edit, id: 'e2', args: { path: 'C:\\proj\\src\\b.ts', contents: 'hi' } }], 'C:\\proj')
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(files[1].added).toBe(1)
  })

  it('finds the CreatePlan file from its progress text', () => {
    const plan: ToolItem = {
      id: '2',
      kind: 'tool',
      callId: 'p',
      tool: 'createPlan',
      args: { name: '待办', plan: '# 计划' },
      status: 'success',
      startedAt: 1,
      result: { success: { stdout: 'Plan saved to file:///C:/Users/me/.cursor/plans/Python%20CLI-819cf0af.plan.md' } }
    }
    const uri = planUriOf(plan)
    expect(uri).toBe('file:///C:/Users/me/.cursor/plans/Python%20CLI-819cf0af.plan.md')
    expect(planPath(uri!)).toBe('C:\\Users\\me\\.cursor\\plans\\Python CLI-819cf0af.plan.md')
    expect(planPath('file:///home/me/.cursor/plans/a.plan.md')).toBe('/home/me/.cursor/plans/a.plan.md')
  })
})

describe('titleFrom', () => {
  it('uses the first line and caps the length', () => {
    expect(titleFrom('\n修复测试\n细节')).toBe('修复测试')
    expect(titleFrom('a'.repeat(49))).toBe(`${'a'.repeat(48)}…`)
  })
})
