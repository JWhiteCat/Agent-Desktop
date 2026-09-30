import { localizedMessage, t as translate } from '@shared/i18n'
import { isCliProvider, normalizeCliProvider, type CliProvider } from '@shared/types'
import { claudeCliInfo, claudeModelList, codexCliInfo, codexModelList, cursorCliInfo, cursorModelList, loginClaude, loginCodex, loginCursor } from '../cli-catalog'
import { updateClaude, updateCodex, updateCursor } from '../cli-update'
import { scanClaudeSessions } from '../claude-history'
import { scanCodexSessions } from '../codex-history'
import { scanCliSessions } from '../history'
import { newId } from '../id'
import type { Handler } from '../remote'
import { syncFromCli } from '../thread-history'
import type { IpcDeps } from './deps'

function chosen(settingsCli: CliProvider, provider?: CliProvider): CliProvider {
  return isCliProvider(provider) ? provider : normalizeCliProvider(settingsCli)
}

function modelList(cli: CliProvider, settings: { agentPath: string; apiKey: string; codexPath: string; codexApiKey: string; claudePath: string; claudeApiKey: string }) {
  if (cli === 'codex') return codexModelList(settings.codexPath, settings.codexApiKey)
  if (cli === 'claude') return claudeModelList(settings.claudePath, settings.claudeApiKey)
  return cursorModelList(settings.agentPath, settings.apiKey)
}

export function cliHandlers(deps: IpcDeps): Record<string, Handler> {
  const { store, broadcast, modelsCache } = deps
  const updating = new Set<CliProvider>()
  const history = {
    store,
    isRunning: (id: string) => deps.sessions.isRunning(id),
    broadcast
  }
  return {
    'cli:models': async (refresh?: boolean, provider?: CliProvider) => {
      const cli = chosen(store.settings.cliProvider, provider)
      const cached = modelsCache.get(cli)
      if (cached && !refresh) return cached
      const models = await modelList(cli, store.settings)
      if (models.length) modelsCache.set(cli, models)
      return models
    },
    'cli:info': async (provider?: CliProvider) => {
      const cli = chosen(store.settings.cliProvider, provider)
      if (cli === 'codex') return codexCliInfo(store.settings.codexPath, store.settings.codexApiKey)
      if (cli === 'claude') return claudeCliInfo(store.settings.claudePath, store.settings.claudeApiKey)
      return cursorCliInfo(store.settings.agentPath, store.settings.apiKey)
    },
    'cli:login': async (provider?: CliProvider) => {
      const cli = chosen(store.settings.cliProvider, provider)
      if (cli === 'codex') return loginCodex(store.settings.codexPath)
      if (cli === 'claude') return loginClaude(store.settings.claudePath)
      return loginCursor(store.settings.agentPath)
    },
    'cli:update': async (provider: CliProvider) => {
      if (!isCliProvider(provider)) throw new Error(translate('请选择要更新的 CLI'))
      if (updating.has(provider)) throw new Error(translate('此 CLI 正在更新，请稍候'))
      updating.add(provider)
      try {
        deps.sessions.dropIdle()
        const result = provider === 'codex'
          ? await updateCodex(store.settings.codexPath)
          : provider === 'claude'
            ? await updateClaude(store.settings.claudePath)
            : await updateCursor(store.settings.agentPath)
        modelsCache.delete(provider)
        deps.sessions.dropIdle()
        return result
      } finally {
        updating.delete(provider)
      }
    },
    'cli:scan': () => {
      const imported = new Set(store.threads.map((t) => t.chatId).filter((x): x is string => !!x))
      return [...scanCliSessions(imported), ...scanCodexSessions(imported), ...scanClaudeSessions(imported)].sort((a, b) => b.updatedAt - a.updatedAt)
    },
    'cli:import': (chatIds: string[]) => {
      const wanted = new Set(chatIds)
      const imported = new Set(store.threads.map((t) => t.chatId).filter(Boolean))
      let count = 0
      const found = [...scanCliSessions(new Set()), ...scanCodexSessions(new Set()), ...scanClaudeSessions(new Set())]
      for (const s of found) {
        if (!wanted.has(s.chatId) || imported.has(s.chatId)) continue
        const project = store.projectByPath(s.cwd) ?? store.addProject(s.cwd)
        const thread = store.createThread({
          projectId: project.id,
          title: s.title,
          titleKind: s.titleKind,
          chatId: s.chatId,
          cwd: s.cwd,
          cli: s.cli,
          mode: 'agent',
          source: 'cli',
          createdAt: s.createdAt || Date.now(),
          updatedAt: s.updatedAt || Date.now()
        })
        let synced = false
        try {
          synced = !!syncFromCli(history, thread.id)
        } catch (err) {
          console.error('[history] import transcript failed', s.chatId, err)
        }
        if (!synced) {
          store.items(thread.id).push({
            id: newId(),
            kind: 'notice',
            level: 'info',
            ...localizedMessage('未能读取此会话的历史消息，发送新消息仍会在原会话上下文中继续。')
          })
          store.markItemsDirty(thread.id)
        }
        count++
      }
      broadcast()
      return count
    }
  }
}
