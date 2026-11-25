import type { Ref } from 'react'
import type { ThreadMeta } from '@shared/types'
import { cliTitle, threadCli } from '@shared/types'
import { displayThreadTitle } from '@shared/thread-title'
import { isThreadUnread } from '@shared/task-counts'
import { copyText } from '../../lib/clipboard'
import { relativeTime } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { errorText, forkThread, openThread, setState, syncThreadFromCli, toast, useStore } from '../../store'
import { IconArchive, IconBranch, IconCopy, IconEdit, IconFolder, IconMore, IconPin, IconRefresh, IconTrash, Spinner } from '../icons'
import { MenuButton, type MenuEntry } from '../Menu'
import { InlineRename } from './InlineRename'

export function ThreadRow(props: {
  thread: ThreadMeta
  active: boolean
  running: boolean
  editing: boolean
  projectName?: string
  rowRef?: Ref<HTMLDivElement>
  onEdit: () => void
  onEditDone: () => void
}) {
  const t = useT()
  const { thread, active, running, editing } = props
  const unread = useStore((s) => isThreadUnread(thread, s.app))
  const title = displayThreadTitle(thread, t)
  const menu: MenuEntry[] = [
    { label: t('重命名'), icon: <IconEdit size={14} />, onSelect: props.onEdit },
    {
      label: t('分叉对话'),
      icon: <IconBranch size={14} />,
      disabled: running,
      hint: running ? t('运行中') : undefined,
      onSelect: () => void forkThread(thread.id)
    },
    { label: thread.pinned ? t('取消置顶') : t('置顶'), icon: <IconPin size={14} />, onSelect: () => window.api.updateThread(thread.id, { pinned: !thread.pinned }) },
    {
      label: thread.archived ? t('取消归档') : t('归档'),
      icon: <IconArchive size={14} />,
      onSelect: () => window.api.updateThread(thread.id, { archived: !thread.archived })
    },
    'separator',
    {
      label: t('从 CLI 同步历史'),
      icon: <IconRefresh size={14} />,
      disabled: !thread.chatId || running,
      onSelect: () => {
        if (thread.source === 'cli' || confirm(t('用 {cli} 保存的记录替换此对话的显示内容？\n耗时、token 统计等应用记录会丢失。', { cli: cliTitle(threadCli(thread)) }))) {
          syncThreadFromCli(thread.id)
        }
      }
    },
    {
      label: t('复制 CLI 会话 ID'),
      icon: <IconCopy size={14} />,
      disabled: !thread.chatId,
      onSelect: () => {
        void copyText(thread.chatId!).then(
          () => toast(t('已复制会话 ID，可用 agent --resume <id> 在终端继续')),
          (err) => toast(t('无法复制：{error}', { error: errorText(err) }), 'error')
        )
      }
    },
    ...(thread.cwd && !window.api.isRemote ? [{ label: t('打开工作目录'), icon: <IconFolder size={14} />, onSelect: () => window.api.openPath(thread.cwd!) }] : []),
    'separator',
    {
      label: t('删除对话'),
      icon: <IconTrash size={14} />,
      danger: true,
      onSelect: () => {
        if (confirm(t('删除对话「{title}」？此操作不可撤销。', { title }))) {
          window.api.deleteThread(thread.id)
          setState((s) => (s.view.kind === 'thread' && s.view.id === thread.id ? { view: { kind: 'home', projectId: thread.projectId } } : {}))
        }
      }
    }
  ]
  return (
    <div
      ref={props.rowRef}
      className={`thread-row ${active ? 'active' : ''} ${thread.archived ? 'archived' : ''}`}
      onClick={() => openThread(thread.id)}
      onDoubleClick={props.onEdit}
      title={thread.preview ? `${title}\n\n${thread.preview}` : title}
    >
      <span className="thread-status">
        {unread ? <span className="unread-dot" /> : running ? <Spinner size={11} /> : thread.pinned ? <IconPin size={11} /> : null}
      </span>
      {editing ? (
        <InlineRename
          value={title}
          onDone={(v) => {
            if (v) window.api.updateThread(thread.id, { title: v })
            props.onEditDone()
          }}
        />
      ) : (
        <>
          <span className="thread-title">
            {title}
            {props.projectName && <span className="thread-project"> · {props.projectName}</span>}
          </span>
          <span className="badge cli-badge" data-cli={threadCli(thread)}>{cliTitle(threadCli(thread))}</span>
        </>
      )}
      <span className="thread-time">{relativeTime(thread.updatedAt)}</span>
      <div className="row-tools" onClick={(e) => e.stopPropagation()}>
        <MenuButton className="icon-btn tiny" items={menu} placement="bottom-end" title={t('对话操作')}>
          <IconMore size={14} />
        </MenuButton>
      </div>
    </div>
  )
}
