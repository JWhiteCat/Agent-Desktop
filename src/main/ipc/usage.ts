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
    'usage:quotas': () => loadQuotas(deps.store.settings.apiKey, deps.store.settings.codexApiKey),
    'usage:quota': (provider: ProviderQuota['provider']) => loadProviderQuota(provider,
      provider === 'cursor' ? deps.store.settings.apiKey : deps.store.settings.codexApiKey),
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
