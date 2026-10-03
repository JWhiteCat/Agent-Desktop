import type { AttachmentData, AttachmentRef, AttachmentUpload } from '@shared/types'
import { isImageAttachment, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES } from '@shared/attachments'
import { t } from '@shared/i18n'
import type { SendOptions } from '../store/state'
import { randomId } from './id'

export interface DraftAttachment {
  key: string
  file: File
  uploaded?: AttachmentRef
  status: 'ready' | 'uploading' | 'error'
  error?: string
}

export function isPreviewImage(mimeType: string): boolean {
  return isImageAttachment({ mimeType })
}

export function attachmentSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KiB`
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`
}

/** Validate the whole batch before accepting it, including existing draft files. */
export function appendDraftAttachments(current: DraftAttachment[], files: File[]): DraftAttachment[] {
  if (current.length + files.length > MAX_ATTACHMENTS) {
    throw new Error(t('每条消息最多添加 {count} 个附件', { count: MAX_ATTACHMENTS }))
  }
  let total = current.reduce((sum, draft) => sum + draft.file.size, 0)
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(t('文件「{name}」超过 10 MiB', { name: file.name }))
    total += file.size
  }
  if (total > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error(t('每条消息的附件总大小不能超过 20 MiB'))
  return [...current, ...files.map((file) => ({ key: randomId(), file, status: 'ready' as const }))]
}

export async function fileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const chunks: string[] = []
  for (let i = 0; i < bytes.length; i += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32_768)))
  }
  return btoa(chunks.join(''))
}

/** Completed uploads stay on the draft so a failed send retries without uploading again. */
export async function uploadDraftAttachments(
  drafts: DraftAttachment[],
  upload: (request: AttachmentUpload) => Promise<AttachmentRef>,
  changed: () => void = () => {}
): Promise<string[]> {
  for (const draft of drafts) {
    if (draft.uploaded) continue
    draft.status = 'uploading'
    draft.error = undefined
    changed()
    try {
      draft.uploaded = await upload({
        name: draft.file.name,
        mimeType: draft.file.type || 'application/octet-stream',
        data: await fileBase64(draft.file)
      })
      draft.status = 'ready'
    } catch (err) {
      draft.status = 'error'
      draft.error = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      changed()
    }
  }
  return drafts.map((draft) => draft.uploaded!.id)
}

/** Plan execution and question replies never pick up files from the composer draft. */
export function textSendOptions(opts: SendOptions, patch?: Partial<SendOptions>): SendOptions {
  const { attachmentIds: _attachments, ...next } = { ...opts, ...patch }
  return next
}

export function attachmentBlob(value: AttachmentData): Blob {
  const binary = atob(value.data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: value.mimeType })
}

export async function downloadAttachment(attachment: AttachmentRef): Promise<void> {
  const blob = attachmentBlob(await window.api.readAttachment(attachment.id))
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = attachment.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Give browser downloads time to consume the object URL before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
