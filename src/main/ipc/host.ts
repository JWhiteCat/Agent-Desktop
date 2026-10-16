import { shell } from 'electron'
import fs from 'node:fs'
import { gitDiff } from '../git'
import type { Handler } from '../remote'
import { userSkillsDir } from '../skills'
import { openInEditor } from '../window'
import { t } from '@shared/i18n'
import { expandToolbarCommand, normalizeToolbarButtons } from '@shared/toolbar'
import type { EditorId } from '@shared/types'
import { launchToolbarCommand } from '../toolbar-terminal'
import type { IpcDeps } from './deps'

export function hostHandlers(deps?: Pick<IpcDeps, 'store'>): Record<string, Handler> {
  return {
    'git:diff': (cwd: string) => gitDiff(cwd),
    'shell:openPath': async (p: string) => {
      const error = await shell.openPath(p)
      if (error) throw new Error(error)
    },
    'shell:openSkills': async () => {
      const dir = userSkillsDir()
      fs.mkdirSync(dir, { recursive: true })
      const error = await shell.openPath(dir)
      if (error) throw new Error(error)
    },
    'shell:openInEditor': async (p: string, editor: EditorId = 'cursor') => {
      const ok = await openInEditor(p, editor)
      if (!ok) {
        const error = await shell.openPath(p)
        if (error) throw new Error(error)
      }
      return ok
    },
    'shell:runToolbarCommand': async (buttonId: string, threadId: string) => {
      const button = normalizeToolbarButtons(deps?.store.settings.threadToolbarButtons)
        .find((item) => item.id === buttonId && item.kind === 'command' && item.visible)
      if (!button || button.kind !== 'command') throw new Error(t('自定义命令不可用或已隐藏。'))
      const thread = deps!.store.threads.find((item) => item.id === threadId)
      const project = deps!.store.projects.find((item) => item.id === thread?.projectId)
      if (!thread || !project) throw new Error(t('未找到会话或所属项目。'))
      const cwd = thread.cwd || project.path
      await launchToolbarCommand({ ...expandToolbarCommand(button, cwd, project.path), cwd })
    },
    'shell:openExternal': (url: string) => {
      if (/^https?:/i.test(url)) return shell.openExternal(url)
    }
  }
}
