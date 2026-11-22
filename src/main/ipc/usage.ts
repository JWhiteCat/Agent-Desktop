import { listSessionUsage, summarizeUsage, type UsageWindow } from '@shared/usage'
import type { CliProvider } from '@shared/types'
import { consumeCodexReset, loadProviderQuota, loadQuotas } from '../quota'
import type { ProviderQuota } from '@shared/quota'
import { newRemoteToken, type Handler } from '../remote'
import type { IpcDeps } from './deps'

export function usageHandlers(deps: IpcDeps): Record<string, Handler> {
  return {
    'usage:summary': (period: UsageWindow, cli?: CliProvider) => {
      const threads = deps.store.threads.map((t) => ({
        id: t.id,
        cli: t.cli,
        title: t.title,
        titleKind: t.titleKind,
        project: deps.store.project(t.projectId)?.name,
        model: t.model,
        updatedAt: t.updatedAt,
        items: deps.store.items(t.id)
      }))
      return { summary: summarizeUsage(threads, period, Date.now(), cli), sessions: listSessionUsage(threads, cli) }
    },
    'usage:quotas': () => loadQuotas(
      deps.store.settings.apiKey,
      deps.store.settings.codexApiKey,
      { path: deps.store.settings.antigravityPath, apiKey: deps.store.settings.antigravityApiKey }
    ),
    'usage:quota': (provider: ProviderQuota['provider']) => {
      if (provider === 'cursor') return loadProviderQuota('cursor', deps.store.settings.apiKey)
      if (provider === 'codex') return loadProviderQuota('codex', deps.store.settings.codexApiKey)
      if (provider === 'antigravity') {
        return loadProviderQuota('antigravity', deps.store.settings.antigravityApiKey, deps.store.settings.antigravityPath)
      }
      throw new Error('Unknown quota provider')
    },
    'usage:consumeCodexReset': (creditId: string) => consumeCodexReset(deps.store.settings.codexApiKey, creditId)
  }
}

export function remoteIpcHandlers(deps: IpcDeps): Record<string, Handler> {
  return {
    'remote:info': () => deps.remoteInfo(),
    'remote:resetToken': async () => {
      deps.store.updateSettings({ remoteToken: newRemoteToken() })
      await deps.applyRemote()
      deps.broadcast()
      return deps.remoteInfo()
    }
  }
}
