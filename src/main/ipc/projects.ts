import { t as translate } from '@shared/i18n'
import { dialog } from 'electron'
import fs from 'node:fs'
import type { Project } from '@shared/types'
import { releaseWorktrees } from '../git'
import type { Handler } from '../remote'
import { worktreeRoot } from '../sessions'
import type { IpcDeps } from './deps'

export function projectHandlers(deps: IpcDeps): Record<string, Handler> {
  const { store, sessions, broadcast } = deps
  return {
    'project:pick': async () => {
      const res = await dialog.showOpenDialog(deps.getWindow()!, {
        title: translate('选择项目文件夹'),
        properties: ['openDirectory', 'createDirectory']
      })
      if (res.canceled || !res.filePaths[0]) return null
      const p = store.addProject(res.filePaths[0])
      broadcast()
      return p
    },
    'project:add': (dir: string) => {
      if (!fs.existsSync(dir)) throw new Error(translate('目录不存在：{path}', { path: dir }))
      const p = store.addProject(dir)
      broadcast()
      return p
    },
    'project:update': (id: string, patch: Partial<Project>) => {
      store.updateProject(id, patch)
      broadcast()
    },
    'project:remove': (id: string) => {
      const threads = store.threads.filter((t) => t.projectId === id)
      for (const t of threads) sessions.dispose(t.id)
      store.removeProject(id)
      void releaseWorktrees(threads, store.threads, worktreeRoot(store))
      broadcast()
    },
    'project:reorder': (ids: string[]) => {
      store.reorderProjects(ids)
      broadcast()
    }
  }
}
