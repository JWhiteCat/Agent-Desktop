import { t as translate } from '@shared/i18n'
import { normalizeMcpServers, normalizeSkills } from '@shared/agent-config'
import { normalizeGrokBotNames } from '@shared/grokbot'
import { normalizeLanguage, setLanguage } from '@shared/i18n'
import { isCliProvider, type Settings } from '@shared/types'
import { syncAllManagedSkills } from '../skills'
import { validClientId, validatePublicHost, validatePublicPort, validatePublicUser, validateSshPort } from '../public-tunnel'
import type { Handler } from '../remote'
import type { IpcDeps } from './deps'

export function settingsHandlers(deps: IpcDeps): Record<string, Handler> {
  return {
    'settings:update': async (patch: Partial<Settings>) => {
      const next: Partial<Settings> = { ...patch }
      if (patch.language !== undefined) next.language = normalizeLanguage(patch.language)
      if (patch.mcpServers !== undefined) next.mcpServers = normalizeMcpServers(patch.mcpServers)
      if (patch.grokbotBots !== undefined) next.grokbotBots = normalizeGrokBotNames(patch.grokbotBots)
      if (patch.remotePort !== undefined) {
        const port = Math.trunc(Number(patch.remotePort))
        if (!(port >= 1024 && port <= 65535)) throw new Error(translate('端口需在 1024–65535 之间'))
        next.remotePort = port
      }
      if (patch.remotePublicUser !== undefined) next.remotePublicUser = validatePublicUser(patch.remotePublicUser)
      if (patch.remotePublicHost !== undefined) next.remotePublicHost = validatePublicHost(patch.remotePublicHost)
      if (patch.remotePublicSshPort !== undefined) next.remotePublicSshPort = validateSshPort(patch.remotePublicSshPort)
      if (patch.remotePublicPort !== undefined) next.remotePublicPort = validatePublicPort(Number(patch.remotePublicPort))
      if (patch.remoteClientId !== undefined) {
        if (!validClientId(String(patch.remoteClientId))) throw new Error(translate('电脑标识无效'))
        next.remoteClientId = patch.remoteClientId
      }
      if (patch.skills !== undefined) {
        next.skills = normalizeSkills(patch.skills)
        syncAllManagedSkills(next.skills)
      }
      if (patch.cliProvider !== undefined && !isCliProvider(patch.cliProvider)) {
        next.cliProvider = 'cursor'
      }
      const s = deps.store.updateSettings(next)
      if (patch.language !== undefined) setLanguage(s.language)
      if (patch.theme) deps.applyTheme(patch.theme)
      if (patch.agentPath !== undefined || patch.apiKey !== undefined) deps.modelsCache.delete('cursor')
      if (patch.codexPath !== undefined || patch.codexApiKey !== undefined) deps.modelsCache.delete('codex')
      if (patch.claudePath !== undefined || patch.claudeApiKey !== undefined) deps.modelsCache.delete('claude')
      if (
        patch.agentPath !== undefined ||
        patch.apiKey !== undefined ||
        patch.codexPath !== undefined ||
        patch.codexApiKey !== undefined ||
        patch.claudePath !== undefined ||
        patch.claudeApiKey !== undefined ||
        patch.sandbox !== undefined ||
        patch.mcpServers !== undefined ||
        patch.skills !== undefined
      ) {
        deps.sessions.dropIdle()
      }
      if (
        patch.remoteEnabled !== undefined ||
        patch.remotePort !== undefined ||
        patch.remoteToken !== undefined ||
        patch.remoteClientId !== undefined ||
        patch.remotePublicEnabled !== undefined ||
        patch.remotePublicUser !== undefined ||
        patch.remotePublicHost !== undefined ||
        patch.remotePublicSshPort !== undefined ||
        patch.remotePublicPort !== undefined
      ) {
        await deps.applyRemote()
      }
      deps.broadcast()
      return s
    }
  }
}
