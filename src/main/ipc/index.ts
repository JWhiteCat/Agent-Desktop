import type { Handler } from '../remote'
import type { IpcDeps } from './deps'
import { cliHandlers } from './cli'
import { attachmentHandlers } from './attachments'
import { hostHandlers } from './host'
import { localConfigHandlers } from './local-config'
import { projectHandlers } from './projects'
import { settingsHandlers } from './settings'
import { threadHandlers } from './threads'
import { remoteIpcHandlers, usageHandlers } from './usage'

export function createIpcHandlers(deps: IpcDeps): Record<string, Handler> {
  return {
    'state:get': () => deps.snapshot(),
    ...projectHandlers(deps),
    ...threadHandlers(deps),
    ...attachmentHandlers(deps),
    ...usageHandlers(deps),
    ...settingsHandlers(deps),
    ...cliHandlers(deps),
    ...hostHandlers(),
    ...localConfigHandlers(deps),
    ...remoteIpcHandlers(deps)
  }
}
