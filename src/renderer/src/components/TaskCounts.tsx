import type { TaskCounts as Counts } from '@shared/task-counts'
import { useT } from '../lib/i18n'

export function TaskCounts({ counts, onOpenUnread, unreadPending = false }: {
  counts: Counts
  onOpenUnread?: () => void
  unreadPending?: boolean
}) {
  const t = useT()
  return (
    <div className="task-counts" role="status" aria-label={t('任务统计')}>
      <span className="task-count">
        <span>{t('正在进行')}</span>
        <strong>{counts.running}</strong>
      </span>
      <button
        type="button"
        className="task-count task-count-button"
        onClick={onOpenUnread}
        disabled={!onOpenUnread || counts.unread === 0 || unreadPending}
        title={t('跳转到下一个未读会话')}
        aria-label={t('跳转到下一个未读会话（{count}）', { count: counts.unread })}
        aria-busy={unreadPending || undefined}
      >
        <span>{t('未读')}</span>
        <strong>{counts.unread}</strong>
      </button>
    </div>
  )
}
