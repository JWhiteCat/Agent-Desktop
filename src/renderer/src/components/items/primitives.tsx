import { useEffect, useMemo, useRef, useState } from 'react'
import { copyText } from '../../lib/clipboard'
import { useT } from '../../lib/i18n'
import { tokenizeCode } from '../../lib/syntax-highlight'
import { errorText, toast } from '../../store/feedback'
import { IconBranch, IconCheck, IconCopy } from '../icons'

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const t = useT()
  const [done, setDone] = useState(false)
  const mounted = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== undefined) {
        clearTimeout(timer.current)
        timer.current = undefined
      }
    }
  }, [])

  return (
    <button
      className={`${className ?? 'icon-btn tiny'}${done ? ' copied' : ''}`}
      title={t('复制')}
      onClick={(e) => {
        e.stopPropagation()
        void copyText(text).then(
          () => {
            if (!mounted.current) return
            setDone(true)
            if (timer.current !== undefined) clearTimeout(timer.current)
            timer.current = setTimeout(() => {
              timer.current = undefined
              if (mounted.current) setDone(false)
            }, 1200)
          },
          (err) => {
            toast(t('无法复制：{error}', { error: errorText(err) }), 'error')
          }
        )
      }}
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  )
}

export function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  const tokens = useMemo(() => tokenizeCode(text, lang), [text, lang])
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang ?? 'text'}</span>
        <CopyButton text={text} />
      </div>
      <pre>
        <code>
          {tokens
            ? tokens.map((tok, i) => (tok.kind === 'plain' ? tok.text : <span key={i} className={`hl-${tok.kind}`}>{tok.text}</span>))
            : text}
        </code>
      </pre>
    </div>
  )
}

export function ForkButton({ onFork }: { onFork: () => void }) {
  const t = useT()
  return (
    <button
      className="icon-btn tiny"
      title={t('从这里分叉')}
      onClick={(e) => {
        e.stopPropagation()
        onFork()
      }}
    >
      <IconBranch size={13} />
    </button>
  )
}
