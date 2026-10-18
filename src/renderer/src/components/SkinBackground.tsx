import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { normalizeSkin, skinUrl, type SkinSource } from '@shared/skins'
import { useStore, errorText } from '../store'
import { applySkin } from '../lib/skins'
import { useT } from '../lib/i18n'

export function SkinBackground() {
  const t = useT()
  const remote = typeof window === 'undefined' || window.api?.isRemote !== false
  const saved = useStore(s => s.app.settings.skin)
  const preview = useStore(s => s.skinPreview)
  const skin = normalizeSkin(preview ?? saved)
  const [source, setSource] = useState<SkinSource>()
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  const [reduced, setReduced] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  const frame = useRef<HTMLIFrameElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const ready = useRef(false)
  const properties = JSON.stringify(skin.properties)
  const key = JSON.stringify(skin)

  useLayoutEffect(() => { applySkin(document.documentElement, JSON.parse(key)) }, [key])
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const changed = () => {
      frame.current?.contentWindow?.postMessage({ type: 'skin-paused', paused: document.hidden }, '*')
      setVisible(!document.hidden)
    }
    const motion = () => {
      frame.current?.contentWindow?.postMessage({ type: 'skin-paused', paused: media.matches }, '*')
      setReduced(media.matches)
    }
    document.addEventListener('visibilitychange', changed)
    media.addEventListener('change', motion)
    return () => { document.removeEventListener('visibilitychange', changed); media.removeEventListener('change', motion) }
  }, [])
  useEffect(() => {
    let canceled = false
    setSource(undefined)
    setError('')
    if (!window.api.isRemote && skin.sourceId && ['image', 'video', 'web'].includes(skin.background)) {
      void window.api.skinSource(skin.sourceId).then(s => { if (!canceled) setSource(s) }, e => { if (!canceled) setError(errorText(e)) })
    }
    return () => { canceled = true }
  }, [skin.sourceId, skin.background, reload])
  useEffect(() => {
    const player = video.current
    if (!player) return
    let active = true
    if (!visible || reduced) player.pause()
    else void player.play().catch(e => { if (active && e?.name !== 'AbortError') setError(errorText(e)) })
    return () => { active = false; player.pause() }
  }, [visible, reduced, source])
  useEffect(() => {
    const send = () => frame.current?.contentWindow?.postMessage({ type: 'skin-properties', properties: JSON.parse(properties) }, '*')
    const receive = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== `skin-asset://${skin.sourceId}`) return
      if (e.data?.type === 'skin-ready') { ready.current = true; send() }
      if (e.data?.type === 'skin-error') setError(t('Web 壁纸运行失败，请选择其他素材。'))
    }
    window.addEventListener('message', receive)
    send()
    return () => window.removeEventListener('message', receive)
  }, [properties, skin.sourceId, t])
  useEffect(() => {
    if (source?.kind !== 'web' || source.id !== skin.sourceId || reduced || !visible) return
    ready.current = false
    const timer = window.setTimeout(() => { if (!ready.current) setError(t('Web 壁纸运行失败，请选择其他素材。')) }, 15000)
    return () => clearTimeout(timer)
  }, [source, skin.sourceId, reduced, visible])
  const current = source?.id === skin.sourceId ? source : undefined
  const dynamic = !reduced && visible
  const url = current ? skinUrl(current, reduced && current.kind !== 'image') : ''
  const failure = () => setError(t('背景加载失败，请重新定位素材或选择其他文件。'))
  return <>
    {!remote && <div className="skin-background" aria-hidden="true">
      {!error && skin.background === 'gradient' && <div className={`skin-gradient ${dynamic ? 'playing' : ''}`} />}
      {!error && current && (current.kind === 'image' || reduced) && url && <img src={url} alt="" style={{ objectFit: skin.fit }} onError={failure} />}
      {!error && current?.kind === 'video' && !reduced && <video key={current.id} ref={video} src={url} autoPlay={visible} muted loop playsInline style={{ objectFit: skin.fit }} onError={failure} />}
      {!error && current?.kind === 'web' && dynamic && <iframe key={current.id} ref={frame} src={url} title={t('动态壁纸')} sandbox="allow-scripts allow-same-origin" inert tabIndex={-1} onError={failure} />}
      <div className="skin-overlay" style={{ backgroundColor: `rgb(0 0 0 / ${skin.overlay}%)` }} />
    </div>}
    {error && <div className="skin-error" role="status">{t('壁纸不可用，可在设置 → 外观中重新定位。')} {error} <button type="button" className="link-btn" onClick={() => setReload(n => n + 1)}>{t('重新加载背景')}</button></div>}
  </>
}
