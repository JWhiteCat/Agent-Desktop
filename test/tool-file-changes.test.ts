import { describe, expect, it } from 'vitest'
import type { Item, ToolItem } from '../src/shared/types'
import { unifiedDiff } from '../src/shared/unified-diff'
import { ToolFileRecorder, restoreToolFileChanges } from '../src/main/tool-file-changes'
import { StreamReducer } from '../src/main/reducer'
import { collectEditedFiles, collectSnapshotTurns } from '../src/renderer/src/lib/diff'
import { transcriptItems } from '../src/main/codex-history'
import { claudeTranscriptItems } from '../src/main/claude-history'

const tool = (patch: Partial<ToolItem> = {}): ToolItem => ({ id: 'tool', kind: 'tool', callId: 'call', tool: 'edit',
  args: { path: 'source.ts' }, status: 'success', startedAt: 0, ...patch })
const diff = (path: string, oldText: string | null = 'before\n', newText = 'agent\n') => ({ type: 'diff', path, oldText, newText })

describe('operation-owned file evidence', () => {
  it('does not infer deletion from an ACP empty replacement string', () => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    reducer.init.cwd = '/project'
    reducer.handleAcp({ sessionUpdate: 'tool_call', toolCallId: 'clear', kind: 'edit', status: 'completed',
      content: [diff('source.ts', 'before\n', '')] })
    const item = items[0] as ToolItem
    for (const text of [item.fileChanges?.[0].diff, item.result?.success?.diffString]) {
      expect(text).toContain('+++ b/source.ts')
      expect(text).toContain('-before')
      expect(text).not.toContain('deleted file mode')
      expect(text).not.toContain('/dev/null')
    }
  })

  it.each(['cursor', 'codex', 'claude'])('retains %s previews until completion and ignores duplicate starts and status-only updates', () => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    reducer.init.cwd = 'C:/project'
    const start = { sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', status: 'pending', content: [diff('a.ts')] }
    reducer.handleAcp(start)
    expect(collectEditedFiles(items)).toEqual([])
    reducer.handleAcp({ ...start, content: [diff('b.ts')] })
    reducer.handleAcp({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' })
    reducer.handleAcp(start)
    expect(items).toHaveLength(1)
    expect(collectEditedFiles(items, 'C:/project').map((file) => file.path)).toEqual(['a.ts', 'b.ts'])
    expect(collectEditedFiles(items)[0]).toMatchObject({ added: 1, removed: 1 })
  })

  it.each(['failed', 'pending', 'in_progress'])('does not attribute %s previews', (status) => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    reducer.handleAcp({ sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', status,
      content: [diff('a.ts')], rawInput: { path: 'a.ts' } })
    reducer.abortRunningTools()
    expect(collectEditedFiles(items)).toEqual([])
  })

  it('records known write targets without manufacturing a creation patch from input', () => {
    const recorder = new ToolFileRecorder()
    const item = tool({ tool: 'Write', args: { file_path: 'existing.ts', contents: 'replacement\n' } })
    recorder.record(item, '/project')
    expect(item.fileChanges).toEqual([{ path: '/project/existing.ts', source: 'edit-input' }])
    expect(collectEditedFiles([item], '/project')[0]).toMatchObject({ added: 0, removed: 0, unavailable: true })
  })

  it('keeps agent patches separate from a different final workspace state in the same file', () => {
    const item = tool()
    new ToolFileRecorder().record(item, '/project', item.args, undefined, [diff('source.ts')])
    const items: Item[] = [{ id: 'u', kind: 'user', text: 'edit', createdAt: 1 }, item,
      { id: 'result', kind: 'result', isError: false, fileChanges: [
        { path: '/project/source.ts', diff: unifiedDiff('source.ts', 'before\n', 'external\n').text },
        { path: '/project/unrelated.ts', diff: unifiedDiff('unrelated.ts', '', 'external\n').text }
      ] }]
    const files = collectEditedFiles(JSON.parse(JSON.stringify(items)), '/project')
    expect(files).toHaveLength(1)
    expect(files[0].lines).toContain('+agent')
    expect(files[0].lines).not.toContain('+external')
    expect(collectSnapshotTurns(items, '/project')[0].files).toHaveLength(2)
  })

  it('preserves multi-file patches before generic history compaction', () => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    reducer.init.cwd = '/project'
    const text = 'a'.repeat(30_000)
    reducer.handleAcp({ sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', status: 'completed',
      rawOutput: { success: { diffString: unifiedDiff('a.ts', '', text).text + '\n' + unifiedDiff('b.ts', 'old', 'new').text } } })
    const item = items[0] as ToolItem
    expect(item.result.success.diffString).toContain('已截断')
    expect(item.fileChanges).toHaveLength(2)
    expect(item.fileChanges![0].diff).toContain(text)
    expect(collectEditedFiles(items, '/project').map((file) => file.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('handles no-ops, empty creations, deletions, binary data and all ApplyPatch targets', () => {
    const recorder = new ToolFileRecorder()
    const item = tool()
    recorder.record(item, '/project', item.args, undefined, [
      diff('same.ts', 'same', 'same'), diff('empty.ts', null, ''), diff('deleted.ts', 'old', ''), diff('binary.dat', null, '\0data')
    ])
    const files = collectEditedFiles([item], '/project')
    expect(files.map((file) => file.path)).toEqual(['empty.ts', 'deleted.ts', 'binary.dat'])
    expect(files[0]).toMatchObject({ unavailable: false, added: 0, removed: 0 })
    expect(files[1].removed).toBe(1)
    expect(files[2].binary).toBe(true)
    const moved = tool({ callId: 'move', tool: 'apply_patch', args: '*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n*** Delete File: removed.ts\n*** End Patch' })
    recorder.record(moved, '/project')
    expect(moved.fileChanges?.map((file) => file.path)).toEqual(['/project/old.ts', '/project/new.ts', '/project/removed.ts'])
  })

  it('keeps oversized paths without persisting invalid partial patches or spending the budget on duplicate notifications', () => {
    const recorder = new ToolFileRecorder()
    const item = tool()
    const large = diff('large.ts', null, 'x'.repeat(257 * 1024))
    recorder.record(item, '/project', item.args, undefined, [large])
    expect(item.fileChanges).toEqual([expect.objectContaining({ path: '/project/large.ts', diffOmitted: true, diff: undefined })])
    const normal = tool({ callId: 'normal' })
    for (let i = 0; i < 100; i++) recorder.record(normal, '/project', normal.args, undefined, [diff('small.ts')])
    expect(normal.fileChanges?.[0].diff).toContain('+agent')
  })

  it('caps the total patch budget without dropping file identities', () => {
    const recorder = new ToolFileRecorder()
    const items: ToolItem[] = []
    for (let i = 0; i < 70; i++) {
      const item = tool({ callId: `edit-${i}` })
      recorder.record(item, '/project', item.args, undefined, [diff(`${i}.ts`, null, 'x'.repeat(250 * 1024))])
      items.push(item)
    }
    const records = items.flatMap((item) => item.fileChanges ?? [])
    expect(records).toHaveLength(70)
    expect(records.reduce((bytes, record) => bytes + Buffer.byteLength(record.diff ?? ''), 0)).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(records.at(-1)).toMatchObject({ diffOmitted: true, diff: undefined })
  })

  it('keeps no-ops excluded across status-only completion and input fallback', () => {
    const items: Item[] = []
    const reducer = new StreamReducer(items)
    reducer.init.cwd = '/project'
    reducer.handleAcp({ sessionUpdate: 'tool_call', toolCallId: 'noop', kind: 'edit', status: 'pending',
      rawInput: { path: 'same.ts' }, content: [diff('same.ts', 'same', 'same')] })
    reducer.handleAcp({ sessionUpdate: 'tool_call_update', toolCallId: 'noop', status: 'completed' })
    expect(collectEditedFiles(items)).toEqual([])
  })

  it('groups Windows aliases, preserves quoted filenames, and never guesses a missing working directory', () => {
    const recorder = new ToolFileRecorder()
    const item = tool()
    recorder.record(item, 'C:/Project', item.args, undefined, [diff('Name.ts')])
    recorder.record(item, 'c:/project', { path: 'name.ts' })
    expect(item.fileChanges).toHaveLength(1)
    const other = tool({ callId: 'second' })
    recorder.record(other, 'c:/project', {}, undefined, [diff('name.ts', 'agent\n', 'next\n')])
    expect(collectEditedFiles([item, other], 'C:/Project')).toHaveLength(1)
    const unusual = tool({ callId: 'quoted' })
    recorder.record(unusual, '/project', {}, undefined, [diff('空 格\t"name.ts')])
    expect(collectEditedFiles([unusual], '/project')[0]).toMatchObject({ path: '空 格\t"name.ts', added: 1, removed: 1 })
    const unknown = tool()
    new ToolFileRecorder().record(unknown, '')
    expect(unknown.fileChanges).toEqual([])
  })

  it('does not upgrade stale success flags, compacted patches, failed results, or shell observations into agent patches', () => {
    const items: Item[] = [tool(), tool({ callId: 'failed', result: { success: {}, error: 'rejected' } }),
      tool({ callId: 'shell', tool: 'shell', args: { command: 'git diff' }, result: { success: { stdout: unifiedDiff('foreign', '', 'outside').text } } }),
      tool({ callId: 'compact', result: { success: { diffString: 'diff --git a/file b/file\n… (已截断 300 字符)' } } }),
      tool({ callId: 'compact-en', args: { path: 'english.ts' }, result: { success: { diffString: 'diff --git a/file b/file\n… (300 characters truncated)' } } }),
      tool({ callId: 'old-failed-patch', tool: 'apply_patch', args: '*** Add File: never.ts', result: { success: { stdout: 'Error: patch did not apply' } } })]
    restoreToolFileChanges(items, '/project')
    expect(collectEditedFiles(items, '/project')).toMatchObject([
      { path: 'source.ts', unavailable: true, added: 0 }, { path: 'english.ts', unavailable: true, added: 0 }
    ])
  })

  it('imports only completed native edits, including custom Codex ApplyPatch calls', () => {
    const rows = [
      { type: 'session_meta', payload: { cwd: '/project' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Edit' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: new.ts\n+hi\n*** End Patch' } }
    ]
    expect(collectEditedFiles(transcriptItems(rows.map((row) => JSON.stringify(row)).join('\n')))).toEqual([])
    rows.push({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'patch', output: 'Success. Updated the following files:\nA new.ts' } } as any)
    expect(collectEditedFiles(transcriptItems(rows.map((row) => JSON.stringify(row)).join('\n')), '/project')).toMatchObject([{ path: 'new.ts', unavailable: true }])
    const claude = claudeTranscriptItems([
      { type: 'assistant', cwd: '/project', message: { content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: '/project/claude.ts', content: 'new' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write', content: 'written' }] } }
    ].map((row) => JSON.stringify(row)).join('\n'))
    expect(collectEditedFiles(claude, '/project')).toMatchObject([{ path: 'claude.ts', unavailable: true }])
  })

  it('keeps snapshot rounds distinct, including missing and empty snapshots, and excludes the active turn', () => {
    const items: Item[] = [
      { id: 'u1', kind: 'user', text: 'first', createdAt: 1 }, { id: 'r1', kind: 'result', isError: false },
      { id: 'u2', kind: 'user', text: 'second', createdAt: 2 }, { id: 'r2', kind: 'result', isError: false, fileChanges: [] },
      { id: 'u3', kind: 'user', text: 'running', createdAt: 3 }
    ]
    expect(collectSnapshotTurns(items, undefined, true)).toEqual([
      { id: 'u1', number: 1, summary: 'first', files: undefined }, { id: 'u2', number: 2, summary: 'second', files: [] }
    ])
    // Native histories may have finished turns without native result items.
    expect(collectSnapshotTurns(items).at(-1)).toMatchObject({ id: 'u3', files: undefined })
  })
})
