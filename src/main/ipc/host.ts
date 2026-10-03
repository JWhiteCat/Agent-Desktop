import { shell } from 'electron'
import fs from 'node:fs'
import { gitDiff } from '../git'
import type { Handler } from '../remote'
import { userSkillsDir } from '../skills'
import { openInEditor } from '../window'

export function hostHandlers(): Record<string, Handler> {
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
    'shell:openInEditor': async (p: string) => {
      const ok = await openInEditor(p)
      if (!ok) {
        const error = await shell.openPath(p)
        if (error) throw new Error(error)
      }
      return ok
    },
    'shell:openExternal': (url: string) => {
      if (/^https?:/i.test(url)) return shell.openExternal(url)
    }
  }
}
