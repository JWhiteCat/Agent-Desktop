import { describe, expect, it } from 'vitest'
import { getNextRunningThread, getNextUnreadThread, getRunningThreads, getTaskCounts, getUnreadThreads } from '../src/shared/task-counts'
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

  it('includes unread waiting conversations in both counts and navigation until viewed', () => {
    const waiting = thread('waiting', { unread: true, archived: true, updatedAt: 3 })
    const state = {
      threads: [waiting, { ...waiting }, thread('busy', { unread: true, updatedAt: 4 }), thread('done', { unread: true })],
      running: ['waiting', 'busy'], waitingForInput: ['waiting', 'waiting', 'deleted']
    }
    expect(getTaskCounts(state)).toEqual({ running: 2, unread: 2 })
    expect(getUnreadThreads(state).map((item) => item.id)).toEqual(['waiting', 'done'])
    expect(getNextUnreadThread(state)?.id).toBe('waiting')
    expect(getNextUnreadThread(state, 'waiting')?.id).toBe('done')
    expect(getTaskCounts({ ...state, threads: state.threads.map((item) => item.id === 'waiting' ? { ...item, unread: false } : item) }))
      .toEqual({ running: 2, unread: 1 })
    expect(getTaskCounts({ ...state, waitingForInput: [] })).toEqual({ running: 2, unread: 1 })
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

  it('cycles through running conversations across projects and archives, ignoring pinning and stale IDs', () => {
    const archived = thread('archived-new', { projectId: 'other', archived: true, updatedAt: 3 })
    const state = {
      threads: [
        thread('pinned-old', { pinned: true, updatedAt: 1 }),
        archived, { ...archived },
        thread('waiting-for-answer', { updatedAt: 2 }),
        thread('completed', { unread: true, updatedAt: 4 })
      ],
      running: ['pinned-old', 'archived-new', 'waiting-for-answer', 'deleted', 'archived-new']
    }
    expect(getRunningThreads(state).map((item) => item.id)).toEqual(['archived-new', 'waiting-for-answer', 'pinned-old'])
    expect(getRunningThreads(state)).toHaveLength(getTaskCounts(state).running)
    expect(getNextRunningThread(state)?.id).toBe('archived-new')
    expect(getNextRunningThread(state, 'archived-new')?.id).toBe('waiting-for-answer')
    expect(getNextRunningThread(state, 'waiting-for-answer')?.id).toBe('pinned-old')
    expect(getNextRunningThread(state, 'pinned-old')?.id).toBe('archived-new')
    expect(getNextRunningThread(state, 'completed')?.id).toBe('archived-new')
    expect(state.running).toHaveLength(5)
    expect(state.threads[0].id).toBe('pinned-old')
  })

  it('reopens a sole running target and follows completion, deletion, and new runs', () => {
    const only = thread('only')
    const newer = thread('newer', { updatedAt: 2 })
    expect(getNextRunningThread({ threads: [only], running: ['only'] }, 'only')).toBe(only)
    expect(getNextRunningThread({ threads: [only], running: [] })).toBeUndefined()
    expect(getNextRunningThread({ threads: [], running: ['only'] })).toBeUndefined()
    expect(getNextRunningThread({ threads: [only, newer], running: ['newer'] }, 'only')).toBe(newer)
  })
})
