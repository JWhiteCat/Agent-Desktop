import { app, dialog, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { MAX_ATTACHMENT_BYTES, type AttachmentData } from '@shared/attachments'
import { mergeManualGrokBots, normalizeGrokBotNames, validateGrokBotName } from '@shared/grokbot'
import { t as translate } from '@shared/i18n'
import type { GrokBotInfo, GrokBotList, GrokBotMessage } from '@shared/types'
import { resolveApiKey } from '../cli'
import { GrokBotClient, readRoster, withAttachments } from '../grokbot'
import { GrokBotFiles, safeFileName } from '../grokbot-files'
import type { Handler } from '../remote'
import type { IpcDeps } from './deps'

const MAX_REFRESH_MESSAGES = 50

function grokBotAppData(): string {
  return app.getPath('appData')
}

/** Files are only served for hashes the transcript handlers have seen. Shared with the `grokbot-file` protocol. */
export const grokBotFiles = new GrokBotFiles(() => path.join(grokBotAppData(), 'Grok Bot', 'attachment-image-cache'))

export interface GrokBotHandlerOptions {
  appDataDir?: () => string
  client?: GrokBotClient
  files?: GrokBotFiles
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
  const list = (): GrokBotList => mergeManualGrokBots(readRoster(appDataDir()), deps.store.settings.grokbotBots ?? [])
  /** Only listed names reach the API, which would otherwise create a bot for an unknown name. */
  const known = (name: unknown): GrokBotInfo => {
    const wanted = typeof name === 'string' ? name : ''
    const bot = list().bots.find((b) => b.name === wanted)
    if (!bot) throw new Error(translate('找不到 Grok Bot「{name}」，请刷新列表', { name: wanted }))
    return bot
  }
  const enrich = (bot: GrokBotInfo, messages: GrokBotMessage[]) => withAttachments(appDataDir(), bot, messages, files)
  const readAttachment = (sha256: unknown) => files.read(sha256)

  return {
    'grokbot:list': () => ({ ...list(), hasApiKey: !!apiKey() }),
    'grokbot:history': async (name: string) => {
      const bot = known(name)
      const history = await client.history(bot.name)
      return { ...history, messages: await enrich(bot, history.messages) }
    },
    'grokbot:poll': async (name: string, cursor: string) => {
      const bot = known(name)
      const page = await client.poll(bot.name, String(cursor ?? ''))
      return { ...page, messages: await enrich(bot, page.messages) }
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
    'grokbot:attachments': (name: string, messages: unknown) => enrich(known(name), sanitizeMessages(messages)),
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
