import { t } from './i18n'
import type { ThreadMeta } from './types'

/** Historical and user-authored titles remain literal, including names matching a placeholder. */
export function displayThreadTitle(thread: Pick<ThreadMeta, 'title' | 'titleKind'>, translate = t): string {
  if (thread.titleKind === 'default') return translate('新对话')
  if (thread.titleKind === 'untitled') return translate('未命名会话')
  return thread.title
}
