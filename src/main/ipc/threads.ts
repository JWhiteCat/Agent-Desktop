import type { AgentMode, PrepareRequest, QuestionAnswer, ThreadMeta } from '@shared/types'
import { threadCli } from '@shared/types'
import { codexChatUpdatedAt } from '../codex-history'
import { cliChatUpdatedAt } from '../history'
import { DEFAULT_TITLE } from '../sessions'
import { forkThread, syncFromCli, type HistoryDeps } from '../thread-history'
import type { Handler } from '../remote'
import type { IpcDeps } from './deps'

function historyDeps(deps: IpcDeps): HistoryDeps {
  return {
    store: deps.store,
    isRunning: (id) => deps.sessions.isRunning(id),
    broadcast: deps.broadcast
  }
}

export function threadHandlers(deps: IpcDeps): Record<string, Handler> {
  const { store, sessions, broadcast } = deps
  const history = historyDeps(deps)
  return {
    'thread:create': (projectId: string, mode: AgentMode, model: string) => {
      if (!store.project(projectId)) throw new Error('项目不存在')
      const t = store.createThread({ projectId, title: DEFAULT_TITLE, mode, model, cli: store.settings.cliProvider, source: 'app' })
      broadcast()
      return t
    },
    'thread:update': (id: string, patch: Partial<ThreadMeta>) => {
      store.updateThread(id, patch)
      broadcast()
    },
    'thread:delete': (id: string) => {
      sessions.dispose(id)
      store.deleteThread(id)
      broadcast()
    },
    'thread:items': (id: string) => {
      const t = store.thread(id)
      if (t?.source === 'cli' && t.chatId && !sessions.isRunning(id)) {
        const cliUpdated = threadCli(t) === 'codex' ? codexChatUpdatedAt(t.chatId) : cliChatUpdatedAt(t.chatId)
        if (cliUpdated && cliUpdated > (t.syncedAt ?? 0)) {
          try {
            if (syncFromCli(history, id)) broadcast()
          } catch (err) {
            console.error('[history] sync failed', err)
          }
        }
      }
      return store.items(id)
    },
    'thread:fork': (id: string, throughItemId?: string) => forkThread(history, id, throughItemId),
    'thread:syncFromCli': (id: string) => {
      if (sessions.isRunning(id)) throw new Error('对话正在运行，请稍后再同步')
      const items = syncFromCli(history, id)
      if (!items) throw new Error(threadCli(store.thread(id) ?? { cli: 'cursor' }) === 'codex' ? '未在 ~/.codex/sessions 中找到该会话' : '未在 ~/.cursor/chats 中找到该会话')
      broadcast()
      return items
    },
    'agent:send': (req) => sessions.send(req),
    'agent:prepare': (threadId: string, opts: PrepareRequest) => sessions.prepare(threadId, opts),
    'agent:stop': (id: string) => sessions.stop(id),
    'agent:answerQuestion': (threadId: string, questionId: string, answers: QuestionAnswer[] | null) => {
      sessions.answerQuestion(threadId, questionId, answers)
    }
  }
}
