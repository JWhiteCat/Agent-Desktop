import { t } from '@shared/i18n'
import { MAX_TOOL_IMAGE_PIXELS } from '@shared/tool-images'
import { MAX_ATTACHMENT_BYTES } from '@shared/attachments'

/** A stable static first frame, not a screenshot of the scaled preview. */
export async function imagePng(blob: Blob): Promise<Blob> {
  if (!blob.size || blob.size > MAX_ATTACHMENT_BYTES || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type)) throw new Error(t('图片格式无效或超过 10 MiB'))
  if (typeof createImageBitmap !== 'function') throw new Error(t('当前浏览器无法转换剪贴板图片'))
  const bitmap = await createImageBitmap(blob)
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 32768 || bitmap.height > 32768 || bitmap.width * bitmap.height > MAX_TOOL_IMAGE_PIXELS) throw new Error(t('图片尺寸过大'))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error(t('图片无法解码'))
    context.drawImage(bitmap, 0, 0)
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error(t('图片无法解码'))), 'image/png'))
    if (png.size > MAX_ATTACHMENT_BYTES) throw new Error(t('PNG 图片超过 10 MiB'))
    return png
  } finally { bitmap.close() }
}
export async function copyBrowserImage(png: Blob): Promise<void> {
  if (png.type !== 'image/png' || !png.size || png.size > MAX_ATTACHMENT_BYTES) throw new Error(t('剪贴板图片必须是有效 PNG'))
  if (!globalThis.isSecureContext || typeof navigator.clipboard?.write !== 'function' || typeof ClipboardItem === 'undefined') throw new Error(t('当前浏览器无法复制图片，请使用 HTTPS 或桌面端'))
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}
