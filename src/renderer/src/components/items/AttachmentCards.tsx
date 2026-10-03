import { useEffect, useState } from 'react'
import type { AttachmentRef } from '@shared/types'
import { useT } from '../../lib/i18n'
import { attachmentBlob, attachmentSize, downloadAttachment, isPreviewImage, type DraftAttachment } from '../../lib/attachments'
import { errorText, toast } from '../../store/feedback'
import { IconArrowDown, IconFile, IconX, Spinner } from '../icons'
import { Modal } from '../Modal'

export function DraftAttachmentCard({ draft, disabled, onRemove }: {
  draft: DraftAttachment
  disabled?: boolean
  onRemove: () => void
}) {
  const t = useT()
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    if (!isPreviewImage(draft.file.type)) return
    const url = URL.createObjectURL(draft.file)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [draft.file])
  return (
    <div className={`attachment-card draft-attachment ${draft.status === 'error' ? 'attachment-failed' : ''}`}>
      <div className="attachment-thumbnail">
        {src ? <img src={src} alt={draft.file.name} /> : <IconFile size={24} />}
      </div>
      <div className="attachment-details">
        <span className="attachment-name" title={draft.file.name}>{draft.file.name}</span>
        <span className="attachment-meta">
          {draft.status === 'uploading'
            ? <><Spinner size={10} /> {t('正在上传')}</>
            : draft.status === 'error'
              ? <span title={draft.error}>{t('上传失败，发送时重试')}</span>
              : attachmentSize(draft.file.size)}
        </span>
      </div>
      <button
        type="button"
        className="icon-btn attachment-remove"
        disabled={disabled}
        title={t('移除 {name}', { name: draft.file.name })}
        aria-label={t('移除 {name}', { name: draft.file.name })}
        onClick={onRemove}
      >
        <IconX size={12} />
      </button>
    </div>
  )
}

function AttachmentCard({ attachment }: { attachment: AttachmentRef }) {
  const t = useT()
  const image = isPreviewImage(attachment.mimeType)
  const [src, setSrc] = useState<string>()
  const [failed, setFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!image) return
    let active = true
    let url: string | undefined
    setSrc(undefined)
    setFailed(false)
    void window.api.readAttachment(attachment.id).then((value) => {
      if (!active) return
      if (!isPreviewImage(value.mimeType)) throw new Error(t('无法预览此图片'))
      url = URL.createObjectURL(attachmentBlob(value))
      setSrc(url)
    }).catch(() => { if (active) setFailed(true) })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [attachment.id, image, refresh, t])

  const download = async () => {
    if (busy) return
    setBusy(true)
    try {
      await downloadAttachment(attachment)
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const open = async () => {
    if (image) {
      if (failed) setRefresh((value) => value + 1)
      else if (src) setPreview(true)
      return
    }
    if (window.api.isRemote) return download()
    if (busy) return
    setBusy(true)
    try {
      await window.api.openAttachment(attachment.id)
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className={`attachment-card message-attachment ${failed ? 'attachment-failed' : ''}`}>
        <button
          type="button"
          className="attachment-content"
          disabled={busy || (image && !src && !failed)}
          title={failed ? t('附件不可用，点击重试') : image ? t('预览 {name}', { name: attachment.name }) : t('打开 {name}', { name: attachment.name })}
          onClick={() => void open()}
        >
          <span className="attachment-thumbnail">
            {image && src ? <img src={src} alt={attachment.name} /> : image && !failed ? <Spinner size={16} /> : <IconFile size={24} />}
          </span>
          <span className="attachment-details">
            <span className="attachment-name">{attachment.name}</span>
            <span className="attachment-meta">{failed ? t('附件不可用，点击重试') : attachmentSize(attachment.size)}</span>
          </span>
        </button>
        <button
          type="button"
          className="icon-btn attachment-download"
          disabled={busy}
          title={t('下载 {name}', { name: attachment.name })}
          aria-label={t('下载 {name}', { name: attachment.name })}
          onClick={() => void download()}
        >
          <IconArrowDown size={14} />
        </button>
      </div>
      {preview && src && (
        <Modal title={attachment.name} wide onClose={() => setPreview(false)} footer={
          <button type="button" className="btn" disabled={busy} onClick={() => void download()}>
            <IconArrowDown size={14} /> {t('下载 {name}', { name: attachment.name })}
          </button>
        }>
          <img className="attachment-preview" src={src} alt={attachment.name} />
        </Modal>
      )}
    </>
  )
}

export function AttachmentCards({ attachments }: { attachments: AttachmentRef[] }) {
  return (
    <div className="attachment-list message-attachments">
      {attachments.map((attachment, index) => <AttachmentCard key={`${attachment.id}:${index}`} attachment={attachment} />)}
    </div>
  )
}
