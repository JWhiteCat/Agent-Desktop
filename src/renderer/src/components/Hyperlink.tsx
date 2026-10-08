import { useCallback, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { localPathFromLink } from '@shared/markdown-links'
import { copyText } from '../lib/clipboard'
import { useT } from '../lib/i18n'
import { errorText, toast } from '../store/feedback'
import { HoverTip } from './HoverTip'
import { ContextMenu } from './Menu'
import { IconCopy } from './icons'

type HyperlinkProps = ComponentPropsWithoutRef<'a'> & { cwd?: string }

/** Preview and copy the same address without changing the link's opening behavior. */
export function Hyperlink({ href, cwd, children, onContextMenu, onKeyDown, ...props }: HyperlinkProps) {
  const t = useT()
  const anchor = useRef<HTMLAnchorElement>(null)
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const close = useCallback(() => setPoint(null), [])
  const address = href ? localPathFromLink(href, cwd) ?? href : undefined
  const copyAddress = async () => {
    if (!address) return
    try {
      await copyText(address)
      toast(t('已复制链接'))
    } catch (error) {
      toast(t('无法复制链接：{error}', { error: errorText(error) }), 'error')
    }
  }
  const keyboardPoint = (el: HTMLAnchorElement) => {
    const rect = el.getBoundingClientRect()
    return { x: rect.left, y: rect.bottom }
  }

  return (
    <>
      <HoverTip text={address} disabled={point !== null} interactive>
        <a
          {...props}
          ref={anchor}
          href={href}
          onContextMenu={(event) => {
            onContextMenu?.(event)
            if (event.defaultPrevented || !address) return
            event.preventDefault()
            event.stopPropagation()
            setPoint(event.clientX || event.clientY
              ? { x: event.clientX, y: event.clientY }
              : keyboardPoint(event.currentTarget))
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event)
            if (event.defaultPrevented || !address) return
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault()
              event.stopPropagation()
              setPoint(keyboardPoint(event.currentTarget))
            }
          }}
        >
          {children}
        </a>
      </HoverTip>
      <ContextMenu
        point={point}
        anchor={anchor.current}
        onClose={close}
        items={[{ label: t('复制链接'), icon: <IconCopy size={14} />, onSelect: () => void copyAddress() }]}
      />
    </>
  )
}
