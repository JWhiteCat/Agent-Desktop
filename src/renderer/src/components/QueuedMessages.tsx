import { useState } from 'react'
import type { AgentMode, QueuedMessage } from '@shared/types'
import { useT } from '../lib/i18n'
import { moveQueued } from '../lib/queue'
import { removeQueued, reorderQueued, sendQueuedNow, toast, useStore } from '../store'
import { IconArrowUp, IconEdit, IconGrip, IconTrash } from './icons'

const DRAG_TYPE = 'application/x-agent-desktop-queued'
const MODE_LABELS: Record<AgentMode, string> = { agent: 'Agent', plan: 'Plan', ask: 'Ask' }

function summary(item: QueuedMessage): string {
  return item.prompt.replace(/\s+/g, ' ').trim()
}

export function QueuedMessages({ threadId, running, onEdit }: {
  threadId: string
  running: boolean
  /** Resolves to false when the composer already has a draft. */
  onEdit: (item: QueuedMessage) => Promise<boolean>
}) {
  const t = useT()
  const queue = useStore((s) => s.app.queued?.[threadId])
  const [dragId, setDragId] = useState<string>()
  const [over, setOver] = useState<{ id: string; after: boolean }>()
  if (!queue?.items.length) return null
  const ids = queue.items.map((item) => item.id)

  const edit = async (item: QueuedMessage) => {
    try {
      if (!(await onEdit(item))) {
        toast(t('请先清空输入框，再编辑排队消息'), 'info')
        return
      }
      await removeQueued(threadId, item.id)
    } catch {
      // The store already reported the failure.
    }
  }

  return (
    <div className="queued-messages" aria-label={t('排队消息')}>
      <div className="queued-header">
        <span>{t('排队中 · {count} 条', { count: queue.items.length })}</span>
        {queue.paused && !running && <span className="queued-paused">{t('队列已暂停，点击“立即发送”继续')}</span>}
      </div>
      {queue.error && <div className="queued-error" role="alert">{queue.error}</div>}
      <ol className="queued-list">
        {queue.items.map((item) => (
          <li
            key={item.id}
            className={`queued-item ${dragId === item.id ? 'dragging' : ''} ${over?.id === item.id ? (over.after ? 'drop-after' : 'drop-before') : ''}`}
            onDragOver={(e) => {
              if (!dragId || !e.dataTransfer.types.includes(DRAG_TYPE)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const rect = e.currentTarget.getBoundingClientRect()
              const after = e.clientY > rect.top + rect.height / 2
              if (over?.id !== item.id || over.after !== after) setOver({ id: item.id, after })
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null) && over?.id === item.id) setOver(undefined)
            }}
            onDrop={(e) => {
              if (!dragId || !e.dataTransfer.types.includes(DRAG_TYPE)) return
              e.preventDefault()
              const rect = e.currentTarget.getBoundingClientRect()
              const next = moveQueued(ids, dragId, item.id, e.clientY > rect.top + rect.height / 2)
              setDragId(undefined)
              setOver(undefined)
              if (next.some((id, i) => id !== ids[i])) void reorderQueued(threadId, next).catch(() => undefined)
            }}
          >
            <span
              className="queued-grip"
              draggable
              title={t('拖动调整顺序')}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, item.id)
                e.dataTransfer.effectAllowed = 'move'
                const row = e.currentTarget.parentElement
                if (row) e.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2)
                setDragId(item.id)
              }}
              onDragEnd={() => {
                setDragId(undefined)
                setOver(undefined)
              }}
            >
              <IconGrip size={14} />
            </span>
            <span className={`queued-mode mode-${item.mode}`} title={t('以 {mode} 模式发送', { mode: MODE_LABELS[item.mode] ?? item.mode })}>
              {MODE_LABELS[item.mode] ?? item.mode}
            </span>
            <span className="queued-text" title={item.prompt}>
              {summary(item) || t('（仅附件）')}
            </span>
            {item.attachments.length > 0 && (
              <span className="queued-meta">{t('{count} 个附件', { count: item.attachments.length })}</span>
            )}
            {item.immediate && <span className="queued-meta">{t('即将发送')}</span>}
            <span className="queued-actions">
              <button type="button" className="icon-btn" title={t('编辑')} aria-label={t('编辑')} onClick={() => void edit(item)}>
                <IconEdit size={13} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title={running ? t('停止当前任务并立即发送') : t('立即发送')}
                aria-label={t('立即发送')}
                onClick={() => void sendQueuedNow(threadId, item.id).catch(() => undefined)}
              >
                <IconArrowUp size={13} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title={t('删除')}
                aria-label={t('删除')}
                onClick={() => void removeQueued(threadId, item.id).catch(() => undefined)}
              >
                <IconTrash size={13} />
              </button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
