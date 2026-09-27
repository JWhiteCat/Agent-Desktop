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
      await shell.openPath(p)
    },
    'shell:openSkills': async () => {
      const dir = userSkillsDir()
      fs.mkdirSync(dir, { recursive: true })
      await shell.openPath(dir)
    },
    'shell:openInEditor': async (p: string) => {
      const ok = await openInEditor(p)
      if (!ok) await shell.openPath(p)
      return ok
    },
    'shell:openExternal': (url: string) => {
      if (/^https?:/.test(url)) return shell.openExternal(url)
    }
  }
}
