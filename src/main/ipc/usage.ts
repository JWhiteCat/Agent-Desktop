import { listSessionUsage, summarizeUsage, type UsageWindow } from '@shared/usage'
import { newRemoteToken, type Handler } from '../remote'
import type { IpcDeps } from './deps'

export function usageHandlers(deps: IpcDeps): Record<string, Handler> {
  return {
    'usage:summary': (period: UsageWindow) => {
      const threads = deps.store.threads.map((t) => ({
        id: t.id,
        title: t.title,
        project: deps.store.project(t.projectId)?.name,
        model: t.model,
        updatedAt: t.updatedAt,
        items: deps.store.items(t.id)
      }))
      return { summary: summarizeUsage(threads, period), sessions: listSessionUsage(threads) }
    }
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
