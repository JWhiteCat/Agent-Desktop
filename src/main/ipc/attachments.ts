import { shell } from 'electron'
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
    'attachment:read': (id: string) => storage().read(id),
    'attachment:open': async (id: string) => {
      const error = await shell.openPath(storage().pathFor(id))
      if (error) throw new Error(error)
    }
  }
}
