import { useCallback, useEffect, useState } from 'react'
import type { ToolItem } from '@shared/types'
import type { ToolImageRef, ToolImageData } from '@shared/tool-images'
import { useT } from '../../lib/i18n'
import { attachmentBlob, attachmentSize, fileBase64 } from '../../lib/attachments'
import { copyText } from '../../lib/clipboard'
import { imagePng, copyBrowserImage } from '../../lib/tool-image-clipboard'
import { errorText, toast } from '../../store/feedback'
import { ContextMenu } from '../Menu'
import { Modal } from '../Modal'
import { Spinner } from '../icons'

function ToolImage({ threadId, itemId, image }: { threadId: string; itemId: string; image: ToolImageRef }) {
  const t = useT()
  const [loaded, setLoaded] = useState<{ src: string; png?: Blob; copyError?: string; data: ToolImageData }>()
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const close = useCallback(() => setPoint(null), [])
  useEffect(() => {
    let active = true
    let url: string | undefined
    setLoaded(undefined); setError(''); setPreview(false); setPoint(null)
    void window.api.readToolImage(threadId, itemId, image.id).then(async (data) => {
      const blob = attachmentBlob(data)
      if (!active) return
      url = URL.createObjectURL(blob)
      // Converting for clipboard must not prevent displaying or copying the path of a valid image.
      setLoaded({ src: url, data })
      try {
        const png = await imagePng(blob)
        if (active) setLoaded({ src: url, png, data })
      } catch (e) {
        if (active) setLoaded({ src: url, copyError: errorText(e), data })
      }
    }).catch((e) => { if (active) setError(errorText(e)) })
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [threadId, itemId, image.id, refresh])
  const original = loaded?.data.sourcePath
  const pathLabel = original ? t('复制图片绝对路径') : t('复制缓存图片路径')
  const copyImage = async () => {
    if (!loaded?.png || busy) return
    setBusy(true)
    try {
      // The browser writes its own device; never route remote copy to the server clipboard.
      if (window.api.isRemote) await copyBrowserImage(loaded.png)
      else await window.api.copyToolImage(threadId, itemId, image.id, await fileBase64(loaded.png))
      toast(t('已复制图片（静态 PNG）'))
    } catch (e) { toast(errorText(e), 'error') }
    finally { setBusy(false) }
  }
  const copyPath = async () => {
    if (!loaded) return
    try { await copyText(original ?? loaded.data.path); toast(t('已复制图片路径')) }
    catch (e) { toast(errorText(e), 'error') }
  }
  const menu = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault(); e.stopPropagation()
    setAnchor(e.currentTarget)
    const rect = e.currentTarget.getBoundingClientRect()
    setPoint({ x: e.clientX || rect.left, y: e.clientY || rect.bottom })
  }
  return <div className="tool-image">
    <div className="small muted">{image.name} · {attachmentSize(image.size)} · {t(image.sourceKind === 'file' ? '本地文件快照（非历史原始图）' : '工具返回图片')}{window.api.isRemote ? ` · ${t('路径位于 CLI 服务端')}` : ''}</div>
    {error ? <button className="btn" onClick={() => setRefresh((x) => x + 1)}>{t('图片不可用，点击重试')}：{error}</button>
      : !loaded ? <Spinner size={16} />
      : <button className="tool-image-open" title={t('点击放大，右键复制')} onClick={() => setPreview(true)} onContextMenu={menu}>
        <img src={loaded.src} alt={image.name} onError={() => setError(t('无法预览此图片'))} />
      </button>}
    <div className="small muted">{t('复制图片为静态 PNG；动画仅复制首帧。')}</div>
    <ContextMenu point={point} anchor={anchor} onClose={close} items={[
      { label: t('复制图片'), disabled: !loaded?.png || busy, hint: loaded?.copyError ?? (!loaded?.png ? t('正在准备图片') : undefined), onSelect: () => { void copyImage() } },
      { label: pathLabel + (window.api.isRemote ? ` (${t('服务端')})` : ''), disabled: !loaded || busy, onSelect: () => { void copyPath() } }
    ]} />
    {loaded?.copyError && <div className="small muted">{t('图片仍可预览，但暂不能复制')}：{loaded.copyError}</div>}
    {preview && loaded && <Modal title={image.name} wide onClose={() => { if (point) close(); else setPreview(false) }}>
      <img tabIndex={0} className="attachment-preview" src={loaded.src} alt={image.name} onContextMenu={menu} />
    </Modal>}
  </div>
}
export function ToolImages({ threadId, item }: { threadId: string; item: ToolItem }) {
  const t = useT()
  const [result, setResult] = useState<{ images: ToolImageRef[]; error?: string; retryable?: boolean }>()
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setResult(undefined)
    void window.api.prepareToolImages(threadId, item.id).then((value) => { if (active) setResult(value) })
      .catch((e) => { if (active) setResult({ images: [], error: errorText(e) }) })
    return () => { active = false }
  }, [threadId, item.id, item.status, JSON.stringify(item.images), item.imageError, refresh])
  return <div className="tool-images">
    {!result && <Spinner size={16} />}
    {result?.images.map((image) => <ToolImage key={image.id} threadId={threadId} itemId={item.id} image={image} />)}
    {result?.error && (result.retryable
      ? <button className="btn" onClick={() => setRefresh((x) => x + 1)}>{t('图片不可用，点击重试')}：{result.error}</button>
      : <div className="small muted">{t('图片不可用')}：{result.error}</div>)}
  </div>
}
