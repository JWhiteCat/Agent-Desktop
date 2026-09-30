import { useState } from 'react'
import { useT } from '../../lib/i18n'
import { IconBranch, IconCheck, IconCopy } from '../icons'

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const t = useT()
  const [done, setDone] = useState(false)
  return (
    <button
      className={className ?? 'icon-btn tiny'}
      title={t('复制')}
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  )
}

export function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang ?? 'text'}</span>
        <CopyButton text={text} />
      </div>
      <pre>
        <code>{text}</code>
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
