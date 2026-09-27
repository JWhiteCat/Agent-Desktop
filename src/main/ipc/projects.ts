import { dialog } from 'electron'
import fs from 'node:fs'
import type { Project } from '@shared/types'
import type { Handler } from '../remote'
import type { IpcDeps } from './deps'

export function projectHandlers(deps: IpcDeps): Record<string, Handler> {
  const { store, sessions, broadcast } = deps
  return {
    'project:pick': async () => {
      const res = await dialog.showOpenDialog(deps.getWindow()!, {
        title: '选择项目文件夹',
        properties: ['openDirectory', 'createDirectory']
      })
      if (res.canceled || !res.filePaths[0]) return null
      const p = store.addProject(res.filePaths[0])
      broadcast()
      return p
    },
    'project:add': (dir: string) => {
      if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`)
      const p = store.addProject(dir)
      broadcast()
      return p
    },
    'project:update': (id: string, patch: Partial<Project>) => {
      store.updateProject(id, patch)
      broadcast()
    },
    'project:remove': (id: string) => {
      for (const t of store.threads.filter((t) => t.projectId === id)) sessions.dispose(t.id)
      store.removeProject(id)
      broadcast()
    },
    'project:reorder': (ids: string[]) => {
      store.reorderProjects(ids)
      broadcast()
    }
  }
}
