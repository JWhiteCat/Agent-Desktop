/** Bytes are stored separately from transcript JSON and transported one file at a time. */
export interface AttachmentRef {
  id: string
  name: string
  mimeType: string
  size: number
}

export interface AttachmentUpload {
  name: string
  mimeType: string
  /** Raw base64, without a data URL prefix. */
  data: string
}

export interface AttachmentData {
  data: string
  mimeType: string
}

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_MESSAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_ATTACHMENTS = 10

export function isImageAttachment(attachment: Pick<AttachmentRef, 'mimeType'>): boolean {
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mimeType)
}
