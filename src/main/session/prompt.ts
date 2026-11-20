import { t as translate } from '@shared/i18n'
import { attachmentPrompt } from '@shared/attachment-message'
import { isImageAttachment, MAX_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES, type AttachmentRef } from '@shared/attachments'
import type { CliProvider, Item, SendRequest } from '@shared/types'
import { attachmentsFor } from '../attachments'
import { forkPrompt } from '../fork-context'
import type { Store } from '../store'
import { cliLabel, planPrompt } from './provider'

export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface BuiltPrompt {
  blocks: PromptBlock[]
  contextThroughId?: string
  managedMessageId?: string
  updatedUserItem?: Item
}

type PromptStore = Pick<Store, 'dataDir' | 'thread' | 'threads' | 'items'>

/**
 * Builds the ACP `session/prompt` content blocks for a turn:
 * appends local attachment paths, injects fallback fork-replay history and images,
 * applies provider Plan/Ask wrappers, and enforces image size/capability limits.
 */
export function buildTurnPrompt(params: {
  store: PromptStore
  threadId: string
  req: SendRequest
  provider: CliProvider
  supportsImage: boolean
  attachments: AttachmentRef[]
  managedMessageId?: string
  userItemId?: string
}): BuiltPrompt {
  const { store, threadId, req, provider, supportsImage, attachments, userItemId } = params
  let managedMessageId = params.managedMessageId
  const contextThroughId = store.thread(threadId)?.forkContextThroughItemId
  let prompt = req.prompt
  let copied: Item[] = []
  if (contextThroughId) {
    const items = store.items(threadId)
    const cut = items.findIndex((item) => item.id === contextThroughId)
    if (cut < 0) throw new Error(translate('分叉历史缺失，无法恢复上下文'))
    copied = items.slice(0, cut + 1)
  }

  // Native forks already retain their image inputs. Only our fallback replay
  // needs to restore bytes from the trusted, persisted prefix of the fork.
  const historicalMessages = copied
    .filter((item) => item.kind === 'user')
    .map((item) => (item.attachments?.length ? attachmentsFor(store).resolveMany(item.attachments.map((attachment) => attachment.id)) : []))
  const historicalAttachments = historicalMessages.flat()

  if (attachments.length) prompt = withAttachmentPaths(store, prompt, attachments)
  if (historicalAttachments.length) prompt = withAttachmentPaths(store, prompt, historicalAttachments, true)

  let updatedUserItem: Item | undefined
  if (historicalAttachments.length && !managedMessageId && userItemId) {
    const item = store.items(threadId).find((it) => it.kind === 'user' && it.id === userItemId)
    if (item?.kind === 'user') {
      item.managedMessageId = managedMessageId = item.id
      updatedUserItem = item
    }
  }
  if (managedMessageId) prompt = attachmentPrompt(prompt, managedMessageId)
  if (contextThroughId) prompt = forkPrompt(copied, prompt)

  const imageRefs = [
    ...new Map([...historicalAttachments, ...attachments].filter(isImageAttachment).map((attachment) => [attachment.id, attachment])).values()
  ]
  if (imageRefs.length > MAX_ATTACHMENTS || imageRefs.reduce((size, attachment) => size + attachment.size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES) {
    throw new Error(translate('分叉历史与本条消息的图片合计超出附件限制，请减少图片或从更早的消息分叉后重试'))
  }
  if (imageRefs.length && !supportsImage) {
    throw new Error(translate('{label} 未声明支持图片输入，请更新 CLI 或移除图片后重试', { label: cliLabel(provider) }))
  }

  const text = planPrompt(provider, req.mode, prompt)
  const images: PromptBlock[] = imageRefs.flatMap<PromptBlock>((attachment) => [
    {
      type: 'text',
      text: `Attached image: ${JSON.stringify({
        id: attachment.id,
        name: attachment.name,
        copiedUserMessages: historicalMessages.flatMap((refs, index) => (refs.some((ref) => ref.id === attachment.id) ? [index + 1] : [])),
        currentMessage: attachments.some((ref) => ref.id === attachment.id)
      })}. Copied user message numbers are one-based within the replayed conversation history.`
    },
    { type: 'image', ...attachmentsFor(store).read(attachment.id) }
  ])

  return {
    blocks: [{ type: 'text', text }, ...images],
    contextThroughId,
    managedMessageId,
    updatedUserItem
  }
}

/** Original files remain outside the project and are read through normal CLI tools. */
function withAttachmentPaths(store: PromptStore, prompt: string, refs: AttachmentRef[], historical = false): string {
  const storeAttachments = attachmentsFor(store)
  const files = [...new Map(refs.map((attachment) => [attachment.id, attachment])).values()].map((attachment) =>
    JSON.stringify({
      name: attachment.name,
      path: storeAttachments.pathFor(attachment.id),
      mimeType: attachment.mimeType,
      size: attachment.size
    })
  )
  const label = historical ? 'Files attached in the copied conversation history:' : 'Files attached to this user message:'
  return `${prompt}\n\n${label}\nRead the original files at these exact local paths when needed.\n${files.join('\n')}`
}
