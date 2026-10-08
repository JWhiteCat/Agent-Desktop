import { app } from 'electron'
import { t as translate } from '@shared/i18n'
import { resolveApiKey } from '../cli'
import { GrokBotClient, readRoster } from '../grokbot'
import type { Handler } from '../remote'
import type { IpcDeps } from './deps'

export function grokbotHandlers(deps: IpcDeps): Record<string, Handler> {
  const apiKey = () => resolveApiKey(deps.store.settings.apiKey)
  const client = new GrokBotClient(apiKey)
  /** Only roster names reach the API, which would otherwise create a bot for an unknown name. */
  const known = (name: unknown): string => {
    const wanted = typeof name === 'string' ? name : ''
    const bot = readRoster(app.getPath('appData')).bots.find((b) => b.name === wanted)
    if (!bot) throw new Error(translate('找不到 Grok Bot「{name}」，请刷新列表', { name: wanted }))
    return bot.name
  }
  return {
    'grokbot:list': () => ({ ...readRoster(app.getPath('appData')), hasApiKey: !!apiKey() }),
    'grokbot:history': (name: string) => client.history(known(name)),
    'grokbot:poll': (name: string, cursor: string) => client.poll(known(name), String(cursor ?? '')),
    'grokbot:send': (name: string, text: string) => client.send(known(name), String(text ?? '')),
    'grokbot:interrupt': (name: string) => client.interrupt(known(name))
  }
}
