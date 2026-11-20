import type { Project } from '@shared/types'
import { useT } from '../../lib/i18n'
import { goHome, setState, useStore } from '../../store'
import { IconChevronDown, IconChevronRight, IconCompose, IconCursor, IconEdit, IconFolder, IconMore, IconTrash, Spinner } from '../icons'
import { MenuButton, type MenuEntry } from '../Menu'
import { InlineRename } from './InlineRename'

export function ProjectRow(props: {
  project: Project
  index: number
  total: number
  count: number
  running: boolean
  editing: boolean
  onEdit: () => void
  onEditDone: () => void
}) {
  const t = useT()
  const { project: p, index, total, editing } = props
  const projects = useStore((s) => s.app.projects)
  const move = (delta: number) => {
    const ids = projects.map((x) => x.id)
    const j = index + delta
    ;[ids[index], ids[j]] = [ids[j], ids[index]]
    window.api.reorderProjects(ids)
  }
  const menu: MenuEntry[] = [
    { label: t('新对话'), icon: <IconCompose size={14} />, onSelect: () => goHome(p.id) },
    ...(window.api.isRemote
      ? []
      : [
          { label: t('在 Cursor 中打开'), icon: <IconCursor size={14} />, onSelect: () => window.api.openInEditor(p.path) },
          { label: t('在文件管理器中打开'), icon: <IconFolder size={14} />, onSelect: () => window.api.openPath(p.path) }
        ]),
    { label: t('重命名'), icon: <IconEdit size={14} />, onSelect: props.onEdit },
    'separator',
    { label: t('上移'), disabled: index === 0, onSelect: () => move(-1) },
    { label: t('下移'), disabled: index === total - 1, onSelect: () => move(1) },
    'separator',
    {
      label: t('移除项目'),
      icon: <IconTrash size={14} />,
      danger: true,
      onSelect: () => {
        if (confirm(t('移除项目「{name}」？\n该项目下的 {count} 个对话记录也会从本应用中删除（不会删除磁盘上的文件）。', { name: p.name, count: props.count }))) {
          window.api.removeProject(p.id)
          setState((s) => (s.view.kind === 'home' && s.view.projectId === p.id ? { view: { kind: 'home' } } : {}))
        }
      }
    }
  ]
  return (
    <div
      className="project-row"
      title={p.path}
      onClick={() => window.api.updateProject(p.id, { collapsed: !p.collapsed })}
    >
      <span className="chev">{p.collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}</span>
      <IconFolder size={15} />
      {editing ? (
        <InlineRename
          value={p.name}
          onDone={(v) => {
            if (v) window.api.updateProject(p.id, { name: v })
            props.onEditDone()
          }}
        />
      ) : (
        <span className="project-name">{p.name}</span>
      )}
      {props.running && p.collapsed && <Spinner size={11} />}
      <div className="row-tools" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn tiny" title={t('在此项目中新建对话')} onClick={() => goHome(p.id)}>
          <IconCompose size={13} />
        </button>
        <MenuButton className="icon-btn tiny" items={menu} placement="bottom-end" title={t('项目操作')}>
          <IconMore size={14} />
        </MenuButton>
      </div>
    </div>
  )
}
