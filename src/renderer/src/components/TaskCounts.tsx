import type { TaskCounts as Counts } from '@shared/task-counts'
import { useT } from '../lib/i18n'

export function TaskCounts({ counts }: { counts: Counts }) {
  const t = useT()
  return (
    <div className="task-counts" role="status" aria-label={t('任务统计')}>
      <span className="task-count">
        <span>{t('正在进行')}</span>
        <strong>{counts.running}</strong>
      </span>
      <span className="task-count">
        <span>{t('未读')}</span>
        <strong>{counts.unread}</strong>
      </span>
    </div>
  )
}
