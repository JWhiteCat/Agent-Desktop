import { shell } from 'electron'
import os from 'node:os'
import path from 'node:path'
import type { LocalMcpSaveRequest, LocalSkillSaveRequest } from '@shared/local-config'
import type { LocalEnv } from '../local-files'
import { deleteLocalMcp, saveLocalMcp, scanLocalMcp, toggleLocalMcp } from '../local-mcp'
import { deleteLocalSkill, readLocalSkill, saveLocalSkill, scanLocalSkills, toggleLocalSkill } from '../local-skills'
import type { Handler } from '../remote'
import type { IpcDeps } from './deps'

export function localConfigHandlers(deps: IpcDeps, trash: (dir: string) => Promise<void> = (dir) => shell.trashItem(dir)): Record<string, Handler> {
  const env = (): LocalEnv => ({ home: os.homedir(), stateDir: path.join(deps.store.dataDir, 'local-config') })
  const projects = () => deps.store.projects.map((p) => p.path)
  /** Idle CLI processes read MCP and skills at start, so they are restarted on next use. */
  const changed = () => deps.sessions.dropIdle()

  return {
    'local:mcpList': () => scanLocalMcp(env(), projects()),
    'local:mcpSave': (req: LocalMcpSaveRequest) => {
      saveLocalMcp(env(), projects(), req)
      changed()
    },
    'local:mcpToggle': (id: string, enabled: boolean, hash?: string) => {
      toggleLocalMcp(env(), projects(), id, !!enabled, hash)
      changed()
    },
    'local:mcpDelete': (id: string, hash?: string) => {
      deleteLocalMcp(env(), projects(), id, hash)
      changed()
    },
    'local:skillList': () => scanLocalSkills(env(), projects()),
    'local:skillRead': (id: string) => readLocalSkill(env(), projects(), id),
    'local:skillSave': (req: LocalSkillSaveRequest) => {
      saveLocalSkill(env(), projects(), req)
      changed()
    },
    'local:skillToggle': (id: string, enabled: boolean) => {
      toggleLocalSkill(env(), projects(), id, !!enabled)
      changed()
    },
    'local:skillDelete': async (id: string) => {
      await deleteLocalSkill(env(), projects(), id, trash)
      changed()
    }
  }
}
