import { useContext, useMemo, useState } from 'react'
import type { NoticeItem, ThinkingItem, UserItem } from '@shared/types'
import { useT } from '../../lib/i18n'
import { IconBrain, IconChevronDown, IconChevronRight, Spinner } from '../icons'
import { Markdown } from './Markdown'
import { CopyButton, ForkButton } from './primitives'
import { TurnActionsContext } from './TurnActions'
import { AttachmentCards } from './AttachmentCards'

export function UserMessage({ item, onFork }: { item: UserItem; onFork?: () => void }) {
  return (
    <div className="msg-user">
      {item.attachments?.length ? <AttachmentCards attachments={item.attachments} /> : null}
      {item.text && <div className="bubble">{item.text}</div>}
      <div className="msg-actions">
        {item.text && <CopyButton text={item.text} />}
        {onFork && <ForkButton onFork={onFork} />}
      </div>
    </div>
  )
}

export function AssistantMessage({ text, streaming, onFork }: { text: string; streaming?: boolean; onFork?: () => void }) {
  const actions = useContext(TurnActionsContext)
  const value = useMemo(() => ({ ...actions, streaming }), [actions, streaming])
  return (
    <div className="msg-assistant-wrap">
      <div className={`msg-assistant ${streaming ? 'streaming' : ''}`}>
        <TurnActionsContext.Provider value={value}>
          <Markdown text={text} />
        </TurnActionsContext.Provider>
      </div>
      {onFork && !streaming && (
        <div className="msg-actions">
          <ForkButton onFork={onFork} />
        </div>
      )}
    </div>
  )
}

export function ThinkingBlock({ item }: { item: ThinkingItem }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const secs = item.endedAt && item.startedAt ? Math.max(1, Math.round((item.endedAt - item.startedAt) / 1000)) : undefined
  return (
    <div className="step">
      <div className="step-head" onClick={() => setOpen((o) => !o)}>
        <span className="step-icon">{item.done ? <IconBrain size={14} /> : <Spinner size={12} />}</span>
        <span className={`step-verb ${item.done ? '' : 'shimmer'}`}>{item.done ? (secs ? t('思考了 {seconds} 秒', { seconds: secs }) : t('思考')) : t('思考中')}</span>
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
      </div>
      {open && item.text.trim() && <div className="step-body thinking-text">{item.text.trim()}</div>}
    </div>
  )
}

export function Notice({ item }: { item: NoticeItem }) {
  const t = useT()
  return <div className={`notice ${item.level}`}>{item.message ? t(item.message.source, item.message.params) : item.text}</div>
}
