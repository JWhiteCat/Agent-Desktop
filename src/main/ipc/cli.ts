import { localizedMessage, t as translate } from '@shared/i18n'
import { isCliProvider, normalizeCliProvider, type CliProvider, type Settings } from '@shared/types'
import { antigravityCliInfo, listAntigravityModels, loginAntigravity, resolveAntigravityApiKey } from '../antigravity'
import { scanAntigravitySessions } from '../antigravity-history'
import { claudeCliInfo, claudeModelList, codexCliInfo, codexModelList, cursorCliInfo, cursorModelList, loginClaude, loginCodex, loginCursor } from '../cli-catalog'
import { updateAntigravity, updateClaude, updateCodex, updateCursor } from '../cli-update'
import { cliInfoCacheFor, cliInfoSignature } from '../cli-info-cache'
import { scanClaudeSessions } from '../claude-history'
import { scanCodexSessions } from '../codex-history'
import { scanCliSessions } from '../history'
import { newId } from '../id'
import type { Handler } from '../remote'
import { syncAntigravityFromCli, syncFromCli } from '../thread-history'
import type { IpcDeps } from './deps'

function chosen(settingsCli: CliProvider, provider?: CliProvider): CliProvider {
  return isCliProvider(provider) ? provider : normalizeCliProvider(settingsCli)
}

function modelList(cli: CliProvider, settings: Settings) {
  if (cli === 'codex') return codexModelList(settings.codexPath, settings.codexApiKey)
  if (cli === 'claude') return claudeModelList(settings.claudePath, settings.claudeApiKey)
  if (cli === 'antigravity') return listAntigravityModels(settings.antigravityPath, resolveAntigravityApiKey(settings.antigravityApiKey))
  return cursorModelList(settings.agentPath, settings.apiKey)
}

export function cliHandlers(deps: IpcDeps): Record<string, Handler> {
  const { store, broadcast, modelsCache } = deps
  const updating = new Set<CliProvider>()
  const infoCache = cliInfoCacheFor(store)
  const history = {
    store,
    isRunning: (id: string) => deps.sessions.isRunning(id),
    broadcast
  }
  const scan = async (imported: Set<string>) => [
    ...scanCliSessions(imported), ...scanCodexSessions(imported), ...scanClaudeSessions(imported),
    ...await scanAntigravitySessions(store.settings, imported)
  ]
  return {
    'cli:models': async (refresh?: boolean, provider?: CliProvider) => {
      const cli = chosen(store.settings.cliProvider, provider)
      const cached = modelsCache.get(cli)
      if (cached && !refresh) return cached
      const models = await modelList(cli, store.settings)
      if (models.length) modelsCache.set(cli, models)
      return models
    },
    'cli:info': async (provider?: CliProvider, refresh = false) => {
      const cli = chosen(store.settings.cliProvider, provider)
      const settings = store.settings
      return infoCache.get(cli, cliInfoSignature(cli, settings), () => {
        if (cli === 'codex') return codexCliInfo(settings.codexPath, settings.codexApiKey)
        if (cli === 'claude') return claudeCliInfo(settings.claudePath, settings.claudeApiKey)
        if (cli === 'antigravity') return antigravityCliInfo(settings.antigravityPath, resolveAntigravityApiKey(settings.antigravityApiKey))
        return cursorCliInfo(settings.agentPath, settings.apiKey)
      }, refresh)
    },
    'cli:login': async (provider?: CliProvider) => {
      const cli = chosen(store.settings.cliProvider, provider)
      try {
        if (cli === 'codex') return await loginCodex(store.settings.codexPath)
        if (cli === 'claude') return await loginClaude(store.settings.claudePath)
        if (cli === 'antigravity') {
          const message = await loginAntigravity(store.settings.antigravityPath)
          modelsCache.delete(cli)
          deps.sessions.dropIdle()
          return message
        }
        return await loginCursor(store.settings.agentPath)
      } finally {
        infoCache.invalidate(cli)
      }
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
            : provider === 'antigravity'
              ? await updateAntigravity(store.settings.antigravityPath)
              : await updateCursor(store.settings.agentPath)
        modelsCache.delete(provider)
        deps.sessions.dropIdle()
        return result
      } finally {
        infoCache.invalidate(provider)
        updating.delete(provider)
      }
    },
    'cli:scan': async () => {
      const imported = new Set(store.threads.map((t) => t.chatId).filter((x): x is string => !!x))
      return (await scan(imported)).sort((a, b) => b.updatedAt - a.updatedAt)
    },
    'cli:import': async (chatIds: string[]) => {
      const wanted = new Set(chatIds)
      let count = 0
      const found = await scan(new Set())
      for (const s of found) {
        if (!wanted.has(s.chatId) || store.threads.some((thread) => thread.chatId === s.chatId)) continue
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
          synced = s.cli === 'antigravity' ? !!await syncAntigravityFromCli(history, thread.id) : !!syncFromCli(history, thread.id)
        } catch (err) {
          console.error('[history] import transcript failed', s.chatId, err)
        }
        if (!synced && store.thread(thread.id)) {
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
