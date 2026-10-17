import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '../src/shared/i18n'
import type { Item, ThreadMeta } from '../src/shared/types'
import { unifiedDiff } from '../src/shared/unified-diff'
import { ChangesPanel } from '../src/renderer/src/components/ChangesPanel'

const { state } = vi.hoisted(() => ({ state: {
  app: { projects: [], running: [] },
  items: {} as Record<string, Item[]>,
  tab: 'thread' as 'thread' | 'snapshot'
} }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return { ...react, useState: (initial: unknown) => react.useState(initial === 'thread' ? state.tab : initial) }
})
vi.mock('../src/renderer/src/store', () => ({
  useStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('../src/renderer/src/components/ResizeHandle', () => ({ ResizeHandle: () => null }))

const thread: ThreadMeta = {
  id: 'thread', projectId: 'project', cwd: '/project', title: 'Changes',
  mode: 'agent', source: 'app', createdAt: 1, updatedAt: 1
}
const binary = (path: string) => ({ path, diff: `diff --git a/${path} b/${path}\nBinary files differ\n` })
const text = (path: string) => ({ path, diff: unifiedDiff(path, 'before\n', 'after\n').text })
const render = (files: { path: string; diff: string }[]) => {
  state.items[thread.id] = [{ id: 'tool', kind: 'tool', callId: 'edit', tool: 'edit', args: {}, status: 'success', startedAt: 0,
    fileChanges: files.map((file) => ({ ...file, source: 'tool-result' })) }]
  return renderToStaticMarkup(createElement(ChangesPanel, { thread, onClose: vi.fn() }))
}

beforeEach(() => {
  setLanguage('zh-CN')
  state.items = {}
  state.tab = 'thread'
})
afterEach(() => setLanguage('system', 'zh-CN'))

describe('changes panel binary group', () => {
  it.each([
    ['zh-CN', '二进制文件（2）', '4 个文件'],
    ['en', 'Binary files (2)', 'Files: 4']
  ] as const)('hides binary names and preserves text order and totals in %s', (language, label, count) => {
    setLanguage(language)
    const html = render([binary('hidden.dat'), text('second.ts'), binary('hidden.png'), text('first.ts')])
    expect(html).toContain(label)
    expect(html).toContain('type="button" class="diff-file-head changes-binary-toggle" aria-expanded="false"')
    expect(html).not.toContain('hidden.dat')
    expect(html).not.toContain('hidden.png')
    expect(html.indexOf('second.ts')).toBeLessThan(html.indexOf('first.ts'))
    expect(html.indexOf('first.ts')).toBeLessThan(html.indexOf(label))
    expect(html).toContain(count)
    expect(html).toContain('<span class="add">+2</span>')
    expect(html).toContain('<span class="del">−2</span>')
    expect(html.match(/class="diff-lines"/g)).toHaveLength(2)
  })

  it('shows a collapsed group without an empty-list hint when all files are binary', () => {
    const html = render([binary('one.dat'), binary('two.dat')])
    expect(html).toContain('二进制文件（2）')
    expect(html).toContain('2 个文件')
    expect(html).not.toContain('class="diff-file"')
    expect(html).not.toContain('class="empty-hint"')
  })

  it('omits the group for text-only and empty lists, using the existing binary flag instead of extensions', () => {
    const html = render([text('text.png')])
    expect(html).toContain('text.png')
    expect(html).toContain('class="diff-lines"')
    expect(html).not.toContain('changes-binary-toggle')
    const empty = render([])
    expect(empty).not.toContain('changes-binary-toggle')
    expect(empty).toContain('本对话还没有编辑文件')
  })

  it.each([8, 9])('keeps the total-file threshold for expanding text diffs (%i files)', (count) => {
    const html = render([...Array.from({ length: count - 1 }, (_, i) => binary(`hidden-${i}.dat`)), text('visible.ts')])
    expect(html).toContain('visible.ts')
    expect(html.includes('class="diff-lines"')).toBe(count <= 8)
    expect(html).toContain(`二进制文件（${count - 1}）`)
    expect(html).not.toContain('hidden-0.dat')
  })
})


describe('snapshot tab', () => {
  it('shows only the latest saved workspace diff, with older turns available and no refresh action', () => {
    state.tab = 'snapshot'
    state.items[thread.id] = [
      { id: 'u1', kind: 'user', text: 'first', createdAt: 1 },
      { id: 'r1', kind: 'result', isError: false, fileChanges: [text('first.ts')] },
      { id: 'u2', kind: 'user', text: 'second', createdAt: 2 },
      { id: 'tool', kind: 'tool', callId: 'edit', tool: 'edit', args: {}, status: 'success', startedAt: 0,
        fileChanges: [{ path: '/project/agent.ts', source: 'edit-input' }] },
      { id: 'r2', kind: 'result', isError: false, fileChanges: [text('external.ts'), binary('hidden.dat')] }
    ]
    const html = renderToStaticMarkup(createElement(ChangesPanel, { thread, onClose: vi.fn() }))
    expect(html).toContain('external.ts')
    expect(html).not.toContain('agent.ts')
    expect(html).not.toContain('first.ts')
    expect(html).toContain('第 1 轮 · first')
    expect(html).toContain('第 2 轮 · second')
    expect(html).toContain('可能包含其他软件的修改')
    expect(html).toContain('二进制文件（1）')
    expect(html).not.toContain('hidden.dat')
    expect(html).not.toContain('title="刷新"')
  })

  it.each([true, false])('distinguishes an empty snapshot from no recorded snapshot (recorded: %s)', (recorded) => {
    state.tab = 'snapshot'
    state.items[thread.id] = [{ id: 'u', kind: 'user', text: 'latest', createdAt: 1 },
      { id: 'result', kind: 'result', isError: false, ...(recorded ? { fileChanges: [] } : {}) }]
    const html = renderToStaticMarkup(createElement(ChangesPanel, { thread, onClose: vi.fn() }))
    expect(html).toContain(recorded ? '本轮没有快照差异' : '本轮未记录快照')
  })
})
