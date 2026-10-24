import { t } from '@shared/i18n'
import { shell, clipboard, ClipboardItem, nativeImage } from 'electron'
import { readToolImage, prepareToolImages, decodeImage } from '../tool-images'
import type { AttachmentUpload } from '@shared/attachments'
import { attachmentsFor } from '../attachments'
import type { Handler } from '../remote'
import type { IpcDeps } from './deps'

export function attachmentHandlers(deps: IpcDeps): Record<string, Handler> {
  const storage = () => attachmentsFor(deps.store)
  return {
    'attachment:upload': (req: AttachmentUpload) => {
      storage().collectGarbage()
      return storage().upload(req)
    },
    'tool-image:list': (threadId: string, itemId: string) => prepareToolImages(deps.store, threadId, itemId),
    'tool-image:read': (threadId: string, itemId: string, imageId: string) => readToolImage(deps.store, threadId, itemId, imageId),
    'tool-image:copy': async (threadId: string, itemId: string, imageId: string, png: string) => {
      readToolImage(deps.store, threadId, itemId, imageId)
      if (typeof png !== 'string') throw new Error(t('图片无效'))
      const bytes = decodeImage(png)
      if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error(t('剪贴板图片必须是 PNG'))
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) throw new Error(t('图片无法解码'))
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })])
    },
    'attachment:read': (id: string) => storage().read(id),
    'attachment:open': async (id: string) => {
      const error = await shell.openPath(storage().pathFor(id))
      if (error) throw new Error(error)
    }
  }
}
