import { t as translate } from '@shared/i18n'
import type { AgentMode, PrepareRequest, QuestionAnswer, ThreadMeta } from '@shared/types'
import { isCliProvider, normalizeCliProvider, threadCli, type CliProvider } from '@shared/types'
import { claudeChatUpdatedAt } from '../claude-history'
import { codexChatUpdatedAt } from '../codex-history'
import { cliChatUpdatedAt } from '../history'
import { releaseWorktrees } from '../git'
import { DEFAULT_TITLE, worktreeRoot } from '../sessions'
import { forkThread, syncFromCli, type HistoryDeps } from '../thread-history'
import type { Handler } from '../remote'
import type { IpcDeps } from './deps'

function missingSessionMessage(cli: CliProvider): string {
  if (cli === 'codex') return translate('未在 ~/.codex/sessions 中找到该会话')
  if (cli === 'claude') return translate('未在 ~/.claude/projects 中找到该会话')
  return translate('未在 ~/.cursor/chats 中找到该会话')
}

function historyDeps(deps: IpcDeps): HistoryDeps {
  return {
    store: deps.store,
    isRunning: (id) => deps.sessions.isRunning(id),
    forkSession: (id) => deps.sessions.forkSession(id),
    broadcast: deps.broadcast
  }
}

export function threadHandlers(deps: IpcDeps): Record<string, Handler> {
  const { store, sessions, broadcast } = deps
  const history = historyDeps(deps)
  return {
    'thread:create': (projectId: string, mode: AgentMode, model: string, force?: boolean, cli?: CliProvider) => {
      if (!store.project(projectId)) throw new Error(translate('项目不存在'))
      const provider = isCliProvider(cli) ? cli : normalizeCliProvider(store.settings.cliProvider)
      const t = store.createThread({ projectId, title: DEFAULT_TITLE, titleKind: 'default', mode, model, force: force ?? store.settings.force, cli: provider, source: 'app' })
      broadcast()
      return t
    },
    'thread:update': (id: string, patch: Partial<ThreadMeta>) => {
      const current = store.thread(id)
      const switching = !!current && patch.cli !== undefined && normalizeCliProvider(patch.cli) !== threadCli(current)
      const next = { ...patch }
      if (switching && sessions.isRunning(id)) delete next.cli
      store.updateThread(id, next)
      if (switching && !sessions.isRunning(id)) sessions.dispose(id)
      broadcast()
    },
    'thread:delete': (id: string) => {
      const thread = store.thread(id)
      sessions.dispose(id)
      store.deleteThread(id)
      if (thread) void releaseWorktrees([thread], [...store.threads, ...store.projects.map((p) => ({ cwd: p.path }))], worktreeRoot(store))
      broadcast()
    },
    'thread:items': (id: string) => {
      const t = store.thread(id)
      if (t?.source === 'cli' && t.chatId && !sessions.isRunning(id)) {
        const cli = threadCli(t)
        const cliUpdated = cli === 'codex' ? codexChatUpdatedAt(t.chatId) : cli === 'claude' ? claudeChatUpdatedAt(t.chatId) : cliChatUpdatedAt(t.chatId)
        if (cliUpdated && cliUpdated > (t.syncedAt ?? 0)) {
          try {
            if (syncFromCli(history, id)) broadcast()
          } catch (err) {
            console.error('[history] sync failed', err)
          }
        }
      }
      const items = store.items(id)
      sessions.refreshCodexUsage(id)
      return items
    },
    'thread:fork': (id: string, throughItemId?: string) => forkThread(history, id, throughItemId),
    'thread:syncFromCli': (id: string) => {
      if (sessions.isRunning(id)) throw new Error(translate('对话正在运行，请稍后再同步'))
      const items = syncFromCli(history, id)
      if (!items) throw new Error(missingSessionMessage(threadCli(store.thread(id) ?? { cli: 'cursor' })))
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
