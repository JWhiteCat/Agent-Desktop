import { useEffect, useState } from 'react'
import { grokBotFileUrl } from '@shared/grokbot'
import type { GrokBotAttachment, GrokBotMessage } from '@shared/types'
import { useT } from '../lib/i18n'
import { attachmentBlob, attachmentSize } from '../lib/attachments'
import { errorText, toast } from '../store'
import { IconArrowDown, IconFile, IconFolder, IconRefresh, Spinner } from './icons'
import { Modal } from './Modal'

/** Shown on every bot file: the source is the Grok Bot app's undocumented cache. */
export const GROKBOT_CACHE_NOTE = '文件来自 Grok Bot 桌面端在这台电脑上的本地缓存（未公开的格式），Grok Bot 更新后可能无法显示。'

/**
 * The desktop window loads cached bytes through the `grokbot-file` protocol. A remote browser
 * cannot reach it, so it fetches the bytes over RPC into a blob URL. Both render through `<img>`,
 * where SVG scripts never run; files are never inlined as markup.
 */
function useAttachmentSrc(attachment: GrokBotAttachment, enabled: boolean): { src?: string; failed: boolean } {
  const [src, setSrc] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setSrc(undefined)
    setFailed(false)
    if (!enabled) return
    if (!window.api.isRemote) {
      setSrc(grokBotFileUrl(attachment.sha256))
      return
    }
    let active = true
    let url: string | undefined
    window.api.grokbotAttachmentData(attachment.sha256).then(
      (value) => {
        if (!active) return
        url = URL.createObjectURL(attachmentBlob({ data: value.data, mimeType: attachment.mimeType }))
        setSrc(url)
      },
      () => active && setFailed(true)
    )
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [attachment.sha256, attachment.mimeType, enabled])
  return { src, failed }
}

async function downloadInBrowser(attachment: GrokBotAttachment): Promise<void> {
  const value = await window.api.grokbotAttachmentData(attachment.sha256)
  const url = URL.createObjectURL(attachmentBlob({ data: value.data, mimeType: attachment.mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = attachment.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function GrokBotAttachmentCard({ attachment }: { attachment: GrokBotAttachment }) {
  const t = useT()
  const usable = attachment.available && !!attachment.sha256
  const image = usable && attachment.kind === 'image'
  const { src, failed } = useAttachmentSrc(attachment, image)
  const [broken, setBroken] = useState(false)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const note = t(GROKBOT_CACHE_NOTE)

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (window.api.isRemote) {
        await downloadInBrowser(attachment)
      } else {
        const saved = await window.api.grokbotSaveAttachment(attachment.sha256)
        if (saved) toast(t('已保存到 {path}', { path: saved }))
      }
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const reveal = async () => {
    try {
      await window.api.grokbotRevealAttachment(attachment.sha256)
    } catch (err) {
      toast(errorText(err), 'error')
    }
  }

  const showImage = image && src && !failed && !broken
  const meta = !usable
    ? t('无法在这里获取，请在 Grok Bot 应用中下载')
    : image && (failed || broken)
      ? t('无法预览此图片')
      : attachment.size !== undefined
        ? attachmentSize(attachment.size)
        : ''

  return (
    <>
      {showImage && (
        <button type="button" className="grokbot-image" title={t('预览 {name}', { name: attachment.name })} onClick={() => setPreview(true)}>
          <img src={src} alt={attachment.alt || attachment.name} onError={() => setBroken(true)} />
        </button>
      )}
      <div className={`attachment-card grokbot-attachment ${usable ? '' : 'grokbot-attachment-missing'}`} title={note}>
        <span className="attachment-thumbnail">
          {image && !src && !failed ? <Spinner size={16} /> : <IconFile size={22} />}
        </span>
        <span className="attachment-details">
          <span className="attachment-name">{attachment.name}</span>
          <span className="attachment-meta">{meta}</span>
        </span>
        {usable && (
          <button
            type="button"
            className="icon-btn attachment-download"
            disabled={busy}
            title={t('下载 {name}', { name: attachment.name })}
            aria-label={t('下载 {name}', { name: attachment.name })}
            onClick={() => void save()}
          >
            <IconArrowDown size={14} />
          </button>
        )}
        {usable && !window.api.isRemote && (
          <button
            type="button"
            className="icon-btn attachment-download"
            title={t('在文件夹中显示')}
            aria-label={t('在文件夹中显示')}
            onClick={() => void reveal()}
          >
            <IconFolder size={14} />
          </button>
        )}
      </div>
      {preview && src && (
        <Modal
          title={attachment.name}
          wide
          onClose={() => setPreview(false)}
          footer={
            <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
              <IconArrowDown size={14} /> {t('下载 {name}', { name: attachment.name })}
            </button>
          }
        >
          <img className="attachment-preview" src={src} alt={attachment.alt || attachment.name} />
        </Modal>
      )}
    </>
  )
}

/** Files of one bot message, or a notice when the API dropped content the local cache cannot supply. */
export function GrokBotMessageExtras({ message, onRecheck }: { message: GrokBotMessage; onRecheck?: () => Promise<void> }) {
  const t = useT()
  const [checking, setChecking] = useState(false)
  if (message.attachments?.length) {
    return (
      <div className="grokbot-attachments">
        {message.attachments.map((a, i) => <GrokBotAttachmentCard key={`${a.sha256 || a.name}:${i}`} attachment={a} />)}
        <div className="grokbot-attachment-note">{t(GROKBOT_CACHE_NOTE)}</div>
      </div>
    )
  }
  if (message.text.trim()) return null
  const text = message.localType
    ? t('这条消息是 Grok Bot 应用中的交互内容（{type}），请在 Grok Bot 中查看。', { type: message.localType })
    : t('这条消息没有文字（可能是文件），Grok Bot API 不提供内容，这台电脑上的 Grok Bot 桌面端缓存里也没有找到。请在 Grok Bot 应用中查看或下载。')
  const recheck = async () => {
    if (!onRecheck || checking) return
    setChecking(true)
    try {
      await onRecheck()
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="attachment-card grokbot-attachment grokbot-attachment-missing grokbot-unknown" title={t(GROKBOT_CACHE_NOTE)}>
      <span className="attachment-thumbnail">
        <IconFile size={22} />
      </span>
      <span className="attachment-details">
        <span className="grokbot-unknown-text">{text}</span>
      </span>
      {onRecheck && !message.localType && (
        <button type="button" className="icon-btn attachment-download" disabled={checking} title={t('重新检查')} aria-label={t('重新检查')} onClick={() => void recheck()}>
          {checking ? <Spinner size={12} /> : <IconRefresh size={14} />}
        </button>
      )}
    </div>
  )
}
