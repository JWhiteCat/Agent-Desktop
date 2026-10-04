import { describe, expect, it } from 'vitest'
import { titleFrom } from '../src/main/sessions'
import { collectEditedFiles, collectGitFiles, parseUnifiedDiff } from '../src/renderer/src/lib/diff'
import { decodeGitPath, quoteGitPath, untrackedGitPaths } from '../src/shared/git-path'
import { basename, duration, formatUsd, relativePath, relativeTime, resetStamp, resetsIn, shortPath } from '../src/renderer/src/lib/format'
import { planPath, planUriOf, summarizeTool, toolDiff } from '../src/renderer/src/lib/tools'
import { unifiedDiff } from '../src/shared/unified-diff'
import type { ToolItem } from '../src/shared/types'

describe('format', () => {
  const now = Date.UTC(2026, 8, 25, 8, 0, 0)

  it('formats relative time and duration', () => {
    expect(relativeTime(now, now)).toBe('刚刚')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分钟')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 小时')
    expect(resetsIn(now + 3 * 3_600_000, now)).toBe('3 小时后')
    expect(resetsIn(now + 30 * 60_000, now)).toBe('30 分钟后')
    expect(resetsIn(now + 2 * 86_400_000, now)).toBe('2 天后')
    expect(resetsIn(now - 1000, now)).toBe('即将重置')
    expect(resetStamp(now)).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}$/)
    expect(duration(500)).toBe('500ms')
    expect(duration(1500)).toBe('2s')
    expect(duration(65_000)).toBe('1m 5s')
    expect(formatUsd(null)).toBe('未定价')
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(0.0026)).toBe('$0.0026')
    expect(formatUsd(0.001)).toBe('$0.001')
    expect(formatUsd(0.00001)).toBe('<$0.0001')
    expect(formatUsd(0.05)).toBe('$0.05')
  })

  it('shortens paths relative to a project root', () => {
    expect(basename('C:\\proj\\src\\cli.ts')).toBe('cli.ts')
    expect(relativePath('C:\\proj\\src\\cli.ts', 'c:\\proj')).toBe('src/cli.ts')
    expect(shortPath('C:/a/b/c/d.ts')).toBe('…/c/d.ts')
  })
})

describe('tools and diffs', () => {
  it('round-trips Git control-character escapes and preserves raw whitespace', () => {
    const file = ' spaced\x07\b\f\n\r\t\v\\"\x01\x7f文件-é.txt '
    const quoted = quoteGitPath(file)
    expect(quoted).not.toMatch(/[\x00-\x1f\x7f]/)
    expect(quoted).toContain('\\001\\177')
    expect(decodeGitPath(quoted)).toBe(file)
    expect(decodeGitPath(' raw spaces ')).toBe(' raw spaces ')
    expect(quoteGitPath('文件-é.txt')).toBe('文件-é.txt')
    expect(untrackedGitPaths(`?? ${quoted}\nR  old.txt -> new.txt\n?? plain.txt\n`)).toEqual([file, 'plain.txt'])
  })

  it('uses decoded status-only paths once when no diff can be rendered', () => {
    const path = ' file\nwith spaces.txt '
    const status = `?? ${quoteGitPath(path)}\n?? ${quoteGitPath(path)}\n`
    expect(collectGitFiles({ diff: '', status })).toEqual([{ path, lines: [], added: 0, removed: 0 }])
  })

  it.each([
    'quote"file.txt', 'back\\slash.txt', 'tab\tfile.txt', 'line\nbreak.txt',
    'carriage\rreturn.txt', ' leading and trailing spaces.txt ', '文件-é.txt'
  ].map((file) => [JSON.stringify(file), file]))('decodes quoted diff paths for %s', (_label, file) => {
    const header = `diff --git ${JSON.stringify(`a/${file}`)} ${JSON.stringify(`b/${file}`)}`
    const files = parseUnifiedDiff(`${header}\n--- /dev/null\n+++ ${JSON.stringify(`b/${file}`)}\n@@ -0,0 +1 @@\n+contents\n`)

    expect(files).toEqual([{ path: file, lines: ['@@ -0,0 +1 @@', '+contents'], added: 1, removed: 0 }])
    expect(parseUnifiedDiff(`${header}\nBinary files /dev/null and ${JSON.stringify(`b/${file}`)} differ\n`))
      .toEqual([{ path: file, lines: [], added: 0, removed: 0, binary: true }])
  })

  it('decodes octal UTF-8 Git paths without interpreting decoded backslashes again', () => {
    const files = parseUnifiedDiff('diff --git "a/\\346\\226\\207\\344\\273\\266-\\134n.txt" "b/\\346\\226\\207\\344\\273\\266-\\134n.txt"\nBinary files differ\n')
    expect(files).toEqual([{ path: '文件-\\n.txt', lines: [], added: 0, removed: 0, binary: true }])
  })

  it('preserves filename spaces while discarding unified header tab separators', () => {
    const file = ' leading and trailing spaces.txt '
    const files = parseUnifiedDiff(`diff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\t\n@@ -0,0 +1 @@\n+contents\n`)
    expect(files).toEqual([{ path: file, lines: ['@@ -0,0 +1 @@', '+contents'], added: 1, removed: 0 }])
  })

  it('finds an unquoted binary path containing a diff-header delimiter', () => {
    const file = 'dir b/name file.txt'
    expect(parseUnifiedDiff(`diff --git a/${file} b/${file}\nBinary files a/${file} and b/${file} differ\n`))
      .toEqual([{ path: file, lines: [], added: 0, removed: 0, binary: true }])
  })

  it('uses decoded rename destinations when no content hunk is present', () => {
    const files = parseUnifiedDiff('diff --git a/old name.txt "b/new\\nname.txt"\nsimilarity index 100%\nrename from old name.txt\nrename to "new\\nname.txt"\n')
    expect(files).toEqual([{ path: 'new\nname.txt', lines: [], added: 0, removed: 0 }])
  })

  it('keeps header-like SQL comments and additions inside the current hunk', () => {
    const body = ['@@ -1,2 +1,3 @@', '--- old comment', '+-- new comment', '+++ extra', ' SELECT 1;']
    const files = parseUnifiedDiff(['diff --git a/query.sql b/query.sql', '--- a/query.sql', '+++ b/query.sql', ...body].join('\n'))
    expect(files).toEqual([{ path: 'query.sql', lines: body, added: 2, removed: 1 }])
  })

  it('separates plain unified patches after consuming each hunk, including zero-line ranges', () => {
    const files = parseUnifiedDiff([
      '--- /dev/null', '+++ b/added.txt', '@@ -0,0 +1 @@', '+++ header-like content',
      '\\ No newline at end of file',
      '--- a/deleted.sql', '+++ /dev/null', '@@ -1 +0,0 @@', '--- SQL comment',
      '--- a/changed.txt', '+++ b/changed.txt', '@@ -1 +1 @@', '-before', '+after',
      '@@ -8 +8 @@', '--- another comment', '+++ another addition'
    ].join('\n'))
    expect(files).toEqual([
      { path: 'added.txt', lines: ['@@ -0,0 +1 @@', '+++ header-like content', '\\ No newline at end of file'], added: 1, removed: 0 },
      { path: 'deleted.sql', lines: ['@@ -1 +0,0 @@', '--- SQL comment'], added: 0, removed: 1 },
      { path: 'changed.txt', lines: ['@@ -1 +1 @@', '-before', '+after', '@@ -8 +8 @@', '--- another comment', '+++ another addition'], added: 2, removed: 2 }
    ])
  })

  it('uses the destination path for plain patches whose old and new names differ', () => {
    const files = parseUnifiedDiff('--- a/old.sql\n+++ b/new.sql\n@@ -1 +1 @@\n--- old comment\n+-- new comment\n')
    expect(files).toEqual([{ path: 'new.sql', lines: ['@@ -1 +1 @@', '--- old comment', '+-- new comment'], added: 1, removed: 1 }])
  })

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
