import { app, dialog, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { MAX_ATTACHMENT_BYTES, type AttachmentData } from '@shared/attachments'
import { mergeManualGrokBots, normalizeGrokBotNames, validateGrokBotName } from '@shared/grokbot'
import { t as translate } from '@shared/i18n'
import type { GrokBotCachedChat, GrokBotHistory, GrokBotInfo, GrokBotList, GrokBotMessage } from '@shared/types'
import { resolveApiKey } from '../cli'
import { GrokBotClient, GrokBotError, readRoster, withAttachments } from '../grokbot'
import { accountTag, GrokBotChatCache } from '../grokbot-cache'
import { GrokBotFiles, safeFileName } from '../grokbot-files'
import type { Handler } from '../remote'
import type { IpcDeps } from './deps'

const MAX_REFRESH_MESSAGES = 50

function grokBotAppData(): string {
  return app.getPath('appData')
}

/** Files are only served for hashes the transcript handlers have seen. Shared with the `grokbot-file` protocol. */
export const grokBotFiles = new GrokBotFiles(() => path.join(grokBotAppData(), 'Grok Bot', 'attachment-image-cache'))

const chatCaches = new Set<GrokBotChatCache>()

/** Writes pending message caches; called on quit. */
export function flushGrokBotCaches(): void {
  for (const cache of chatCaches) cache.flush()
}

/** A saved cursor that the API rejects (bad cursor or unknown session) is recovered with a full reload. */
const RELOAD_STATUSES = new Set([400, 404, 410])

export interface GrokBotHandlerOptions {
  appDataDir?: () => string
  client?: GrokBotClient
  files?: GrokBotFiles
  cache?: GrokBotChatCache
}

/** Messages echoed back by the renderer, reduced to fields the attachment lookup trusts. */
function sanitizeMessages(value: unknown): GrokBotMessage[] {
  if (!Array.isArray(value)) return []
  return value.slice(-MAX_REFRESH_MESSAGES).flatMap((m): GrokBotMessage[] => {
    if (!m || typeof m !== 'object' || (m.role !== 'bot' && m.role !== 'user')) return []
    return [{
      seq: String(m.seq ?? ''),
      updatedSeq: String(m.updatedSeq ?? ''),
      role: m.role,
      text: typeof m.text === 'string' ? m.text : '',
      createdAtMs: Number(m.createdAtMs) || 0
    }]
  })
}

export function grokbotHandlers(deps: IpcDeps, options: GrokBotHandlerOptions = {}): Record<string, Handler> {
  const appDataDir = options.appDataDir ?? grokBotAppData
  const apiKey = () => resolveApiKey(deps.store.settings.apiKey)
  const client = options.client ?? new GrokBotClient(apiKey)
  const files = options.files ?? grokBotFiles
  const cache = options.cache ?? new GrokBotChatCache(() => path.join(deps.store.dataDir, 'grokbot-cache.json'))
  chatCaches.add(cache)
  const account = () => accountTag(apiKey())
  const list = (): GrokBotList => mergeManualGrokBots(readRoster(appDataDir()), deps.store.settings.grokbotBots ?? [])
  /** Only listed names reach the API, which would otherwise create a bot for an unknown name. */
  const known = (name: unknown): GrokBotInfo => {
    const wanted = typeof name === 'string' ? name : ''
    const bot = list().bots.find((b) => b.name === wanted)
    if (!bot) throw new Error(translate('找不到 Grok Bot「{name}」，请刷新列表', { name: wanted }))
    return bot
  }
  const enrich = (bot: GrokBotInfo, messages: GrokBotMessage[]) => withAttachments(appDataDir(), bot, messages, files)
  /** Continues from `after`, or reloads everything when the cursor or session no longer fits. */
  const pollOrReload = async (name: string, after: string, sessionId?: string): Promise<GrokBotHistory> => {
    let page: GrokBotHistory
    try {
      page = await client.poll(name, after)
    } catch (err) {
      if (!(err instanceof GrokBotError) || !RELOAD_STATUSES.has(err.status ?? 0)) throw err
      client.forgetSession(name)
      return { ...(await client.history(name)), reset: true }
    }
    const otherSession = !!sessionId && page.sessionId !== sessionId
    const behind = !!after && after !== '-1' && Number(page.cursor) < Number(after)
    return otherSession || behind ? { ...(await client.history(name)), reset: true } : page
  }
  const readAttachment = (sha256: unknown) => files.read(sha256)

  return {
    'grokbot:list': () => ({ ...list(), hasApiKey: !!apiKey() }),
    /** Messages saved from an earlier visit, without a network request. Null when there are none. */
    'grokbot:cached': async (name: string): Promise<GrokBotCachedChat | null> => {
      const bot = known(name)
      const saved = cache.get(bot.name, account())
      if (!saved) return null
      if (saved.sessionId) client.rememberSession(bot.name, saved.sessionId)
      return { ...saved, messages: await enrich(bot, saved.messages) }
    },
    'grokbot:history': async (name: string) => {
      const bot = known(name)
      const history = await client.history(bot.name)
      const out = { ...history, messages: await enrich(bot, history.messages) }
      cache.update(bot.name, account(), '-1', out, true)
      return out
    },
    'grokbot:poll': async (name: string, cursor: string, sessionId?: string) => {
      const bot = known(name)
      const after = String(cursor ?? '')
      const page = await pollOrReload(bot.name, after, typeof sessionId === 'string' && sessionId ? sessionId : undefined)
      const out = { ...page, messages: await enrich(bot, page.messages) }
      cache.update(bot.name, account(), after, out)
      return out
    },
    'grokbot:send': (name: string, text: string) => client.send(known(name).name, String(text ?? '')),
    'grokbot:interrupt': (name: string) => client.interrupt(known(name).name),
    /** The only path that may send an unlisted name: the API creates the bot when the account has none. */
    'grokbot:create': async (name: unknown) => {
      const wanted = validateGrokBotName(name)
      await client.create(wanted)
      const saved = deps.store.settings.grokbotBots ?? []
      if (!list().bots.some((b) => b.name === wanted)) {
        deps.store.updateSettings({ grokbotBots: normalizeGrokBotNames([...saved, wanted]) })
        deps.broadcast()
      }
      return known(wanted)
    },
    /** Looks again for files of messages the local cache did not have yet. No API request. */
    'grokbot:attachments': async (name: string, messages: unknown) => {
      const bot = known(name)
      const found = await enrich(bot, sanitizeMessages(messages))
      cache.patch(bot.name, account(), found.filter((m) => m.attachments !== undefined))
      return found
    },
    /** Base64 bytes for browsers that cannot reach the `grokbot-file` protocol. */
    'grokbot:attachmentData': async (sha256: unknown): Promise<AttachmentData> => {
      const cached = await readAttachment(sha256)
      if (cached.bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(translate('文件超过 10 MiB，请在电脑上打开'))
      return { data: cached.bytes.toString('base64'), mimeType: cached.mimeType }
    },
    'grokbot:attachmentSave': async (sha256: unknown): Promise<string> => {
      const cached = await readAttachment(sha256)
      const win = deps.getWindow()
      const defaultPath = path.join(app.getPath('downloads'), safeFileName(cached.name, `${String(sha256)}.bin`))
      const result = win ? await dialog.showSaveDialog(win, { defaultPath }) : await dialog.showSaveDialog({ defaultPath })
      if (result.canceled || !result.filePath) return ''
      await fs.promises.writeFile(result.filePath, cached.bytes)
      return result.filePath
    },
    'grokbot:attachmentReveal': async (sha256: unknown) => {
      shell.showItemInFolder((await readAttachment(sha256)).file)
    }
  }
}
