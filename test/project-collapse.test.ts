import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectHandlers } from '../src/main/ipc/projects'
import type { IpcDeps } from '../src/main/ipc/deps'
import { Store } from '../src/main/store'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => electron.userData }, dialog: {} }))
vi.mock('../src/main/git', () => ({ releaseWorktrees: vi.fn() }))
vi.mock('../src/main/sessions', () => ({ worktreeRoot: vi.fn() }))

describe('collapse all projects', () => {
  let store: Store

  beforeEach(() => {
    electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-project-collapse-'))
    store = new Store()
  })

  afterEach(() => {
    store.flush()
    const dir = path.resolve(electron.userData)
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('agent-desktop-project-collapse-')) {
      throw new Error(`Unexpected test directory: ${dir}`)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('persists every collapse in one batch and broadcasts one snapshot without changing conversation metadata', () => {
    const projects = ['first', 'second', 'third'].map((name) => store.addProject(path.join(electron.userData, name), name))
    store.updateProject(projects[2].id, { collapsed: true })
    const thread = store.createThread({ projectId: projects[0].id, title: 'Selected', mode: 'agent', source: 'app', unread: true })
    const savedThread = { ...thread }
    store.flush()
    const scheduleSave = vi.spyOn(store as unknown as { scheduleSave(): void }, 'scheduleSave')
    const broadcast = vi.fn()

    projectHandlers({ store, broadcast, sessions: {} } as unknown as IpcDeps)['project:collapseAll']()

    expect(scheduleSave).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(store.projects.map((project) => project.collapsed)).toEqual([true, true, true])
    expect(store.thread(thread.id)).toEqual(savedThread)
    store.flush()
    const restored = new Store()
    expect(restored.projects.map((project) => project.name)).toEqual(['first', 'second', 'third'])
    expect(restored.projects.every((project) => project.collapsed)).toBe(true)
  })

  it('accepts empty and already collapsed projects without scheduling another save', () => {
    const scheduleSave = vi.spyOn(store as unknown as { scheduleSave(): void }, 'scheduleSave')
    store.collapseAllProjects()
    expect(scheduleSave).not.toHaveBeenCalled()
    const project = store.addProject(electron.userData)
    store.updateProject(project.id, { collapsed: true })
    scheduleSave.mockClear()

    store.collapseAllProjects()

    expect(scheduleSave).not.toHaveBeenCalled()
  })
})
