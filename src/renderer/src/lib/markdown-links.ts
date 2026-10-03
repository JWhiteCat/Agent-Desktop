import { t } from '@shared/i18n'
import { localPathFromLink } from '@shared/markdown-links'
import { errorText, toast } from '../store/feedback'

/** Web links open on the client; local artifacts open on the desktop that owns the conversation. */
export async function openMarkdownLink(href: string | undefined, cwd?: string): Promise<void> {
  try {
    const file = href ? localPathFromLink(href, cwd) : undefined
    if (file) {
      await window.api.openPath(file)
      if (window.api.isRemote) toast(t('已在桌面端打开文件'))
    } else if (href && /^https?:\/\//i.test(href)) {
      await window.api.openExternal(href)
    } else {
      toast(t('无法打开此链接：不支持的地址格式'), 'error')
    }
  } catch (error) {
    toast(t('无法打开链接：{error}', { error: errorText(error) }), 'error')
  }
}
