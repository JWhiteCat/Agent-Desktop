import type { TaskCounts as Counts } from '@shared/task-counts'
import { useT } from '../lib/i18n'

export function TaskCounts({ counts, onOpenRunning, onOpenUnread, navigationPending = false }: {
  counts: Counts
  onOpenRunning?: () => void
  onOpenUnread?: () => void
  navigationPending?: boolean
}) {
  const t = useT()
  return (
    <div className="task-counts" role="status" aria-label={t('任务统计')}>
      <button
        type="button"
        className="task-count task-count-button"
        onClick={onOpenRunning}
        disabled={!onOpenRunning || counts.running === 0 || navigationPending}
        title={t('跳转到下一个正在进行的会话')}
        aria-label={t('跳转到下一个正在进行的会话（{count}）', { count: counts.running })}
        aria-busy={navigationPending || undefined}
      >
        <span>{t('正在进行')}</span>
        <strong>{counts.running}</strong>
      </button>
      <button
        type="button"
        className="task-count task-count-button"
        onClick={onOpenUnread}
        disabled={!onOpenUnread || counts.unread === 0 || navigationPending}
        title={t('跳转到下一个未读会话')}
        aria-label={t('跳转到下一个未读会话（{count}）', { count: counts.unread })}
        aria-busy={navigationPending || undefined}
      >
        <span>{t('未读')}</span>
        <strong>{counts.unread}</strong>
      </button>
    </div>
  )
}
