import { describe, expect, it } from 'vitest'
import { getNextUnreadThread, getTaskCounts, getUnreadThreads } from '../src/shared/task-counts'
import type { ThreadMeta } from '../src/shared/types'

function thread(id: string, extra: Partial<ThreadMeta> = {}): ThreadMeta {
  return { id, projectId: 'project', title: id, mode: 'agent', source: 'app', createdAt: 1, updatedAt: 1, ...extra }
}

describe('global task counts', () => {
  it('shows zero when no existing conversations are running or unread', () => {
    expect(getTaskCounts({ threads: [], running: ['deleted'] })).toEqual({ running: 0, unread: 0 })
    expect(getTaskCounts({ threads: [thread('read')], running: [] })).toEqual({ running: 0, unread: 0 })
  })

  it('includes archived conversations across every project and excludes running conversations from unread', () => {
    const state = {
      threads: [
        thread('running', { unread: true }),
        thread('waiting-for-answer', { projectId: 'other-project' }),
        thread('archived', { projectId: 'other-project', archived: true, unread: true }),
        thread('completed', { unread: true }),
        thread('read', { unread: false })
      ],
      running: ['running', 'waiting-for-answer', 'deleted', 'running']
    }
    expect(getTaskCounts(state)).toEqual({ running: 2, unread: 2 })
    expect(state.running).toEqual(['running', 'waiting-for-answer', 'deleted', 'running'])
    expect(state.threads[0].unread).toBe(true)
  })

  it('counts each conversation once even if duplicate IDs are supplied', () => {
    const duplicate = thread('completed', { unread: true })
    expect(getTaskCounts({ threads: [duplicate, { ...duplicate }, thread('running')], running: ['running', 'running'] }))
      .toEqual({ running: 1, unread: 1 })
  })

  it('includes all completed outcomes marked unread and follows running, read, and deletion changes', () => {
    const threads = ['success', 'failed', 'stopped'].map((id) => thread(id, { unread: true }))
    expect(getTaskCounts({ threads, running: [] })).toEqual({ running: 0, unread: 3 })
    expect(getTaskCounts({ threads, running: ['success'] })).toEqual({ running: 1, unread: 2 })
    expect(getTaskCounts({ threads: threads.map((item) => ({ ...item, unread: false })), running: [] }))
      .toEqual({ running: 0, unread: 0 })
    expect(getTaskCounts({ threads: [], running: ['success'] })).toEqual({ running: 0, unread: 0 })
  })

  it('navigates newest unread first across archives, ignoring pinned and running conversations', () => {
    const state = {
      threads: [
        thread('pinned-old', { pinned: true, unread: true, updatedAt: 1 }),
        thread('archived-new', { archived: true, unread: true, updatedAt: 3 }),
        thread('running', { unread: true, updatedAt: 4 }),
        thread('middle', { unread: true, updatedAt: 2 }),
        thread('read', { updatedAt: 5 })
      ],
      running: ['running']
    }
    expect(getUnreadThreads(state).map((item) => item.id)).toEqual(['archived-new', 'middle', 'pinned-old'])
    expect(getNextUnreadThread(state)?.id).toBe('archived-new')
    expect(getNextUnreadThread(state, 'archived-new')?.id).toBe('middle')
    expect(getNextUnreadThread(state, 'middle')?.id).toBe('pinned-old')
    expect(getNextUnreadThread(state, 'pinned-old')?.id).toBe('archived-new')
    expect(getNextUnreadThread(state, 'read')?.id).toBe('archived-new')
  })

  it('retries a sole unread target, deduplicates it, and handles no unread targets', () => {
    const unread = thread('only', { unread: true })
    expect(getUnreadThreads({ threads: [unread, { ...unread }], running: [] })).toEqual([unread])
    expect(getNextUnreadThread({ threads: [unread], running: [] }, unread.id)).toBe(unread)
    expect(getNextUnreadThread({ threads: [], running: [] })).toBeUndefined()
  })
})
