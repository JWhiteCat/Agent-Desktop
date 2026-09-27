import type { CliProvider } from '@shared/types'
import { codexCliInfo, codexModelList, cursorCliInfo, cursorModelList, loginCodex, loginCursor } from '../cli-catalog'
import { scanCodexSessions } from '../codex-history'
import { scanCliSessions } from '../history'
import { newId } from '../id'
import type { Handler } from '../remote'
import { syncFromCli } from '../thread-history'
import type { IpcDeps } from './deps'

function chosen(settingsCli: CliProvider, provider?: CliProvider): CliProvider {
  return provider === 'codex' || provider === 'cursor' ? provider : settingsCli
}

export function cliHandlers(deps: IpcDeps): Record<string, Handler> {
  const { store, broadcast, modelsCache } = deps
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
      const models = cli === 'codex' ? await codexModelList(store.settings.codexPath, store.settings.codexApiKey) : await cursorModelList(store.settings.agentPath, store.settings.apiKey)
      if (models.length) modelsCache.set(cli, models)
      return models
    },
    'cli:info': async (provider?: CliProvider) => {
      const cli = chosen(store.settings.cliProvider, provider)
      if (cli === 'codex') return codexCliInfo(store.settings.codexPath, store.settings.codexApiKey)
      return cursorCliInfo(store.settings.agentPath, store.settings.apiKey)
    },
    'cli:login': async (provider?: CliProvider) => {
      const cli = chosen(store.settings.cliProvider, provider)
      if (cli === 'codex') return loginCodex(store.settings.codexPath)
      return loginCursor(store.settings.agentPath)
    },
    'cli:scan': () => {
      const imported = new Set(store.threads.map((t) => t.chatId).filter((x): x is string => !!x))
      return [...scanCliSessions(imported), ...scanCodexSessions(imported)].sort((a, b) => b.updatedAt - a.updatedAt)
    },
    'cli:import': (chatIds: string[]) => {
      const wanted = new Set(chatIds)
      const imported = new Set(store.threads.map((t) => t.chatId).filter(Boolean))
      let count = 0
      const found = [...scanCliSessions(new Set()), ...scanCodexSessions(new Set())]
      for (const s of found) {
        if (!wanted.has(s.chatId) || imported.has(s.chatId)) continue
        const project = store.projectByPath(s.cwd) ?? store.addProject(s.cwd)
        const thread = store.createThread({
          projectId: project.id,
          title: s.title,
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
            text: '未能读取此会话的历史消息，发送新消息仍会在原会话上下文中继续。'
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
