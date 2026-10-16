import { useEffect, useRef, useState, type FormEvent } from 'react'
import { normalizeToolbarButtons } from '@shared/toolbar'
import type { BuiltinToolbarAction, ToolbarButton } from '@shared/types'
import { randomId } from '../../lib/id'
import { useT } from '../../lib/i18n'
import { errorText, toast, useStore } from '../../store'
import { IconArrowDown, IconArrowUp, IconEdit, IconPlus, IconTerminal, IconTrash } from '../icons'

type CommandButton = Extract<ToolbarButton, { kind: 'command' }>
interface CommandDraft { id?: string; name: string; program: string; args: string }

const BUILTIN_NAMES: Record<BuiltinToolbarAction, string> = {
  fork: '分叉对话', files: '在文件管理器中打开', vscode: '在 VS Code 中打开', cursor: '在 Cursor 中打开', changes: '变更面板'
}

/** Arguments are literal lines, so preserve whitespace and quotes within each nonempty line. */
export function toolbarArgumentLines(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.trim().length > 0)
}

export function ToolbarSettings() {
  const t = useT()
  const saved = useStore((state) => state.app.settings.threadToolbarButtons)
  const [buttons, setButtons] = useState(() => normalizeToolbarButtons(saved))
  const [editing, setEditing] = useState<CommandDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  useEffect(() => { if (!savingRef.current) setButtons(normalizeToolbarButtons(saved)) }, [saved])

  const save = async (next: ToolbarButton[]): Promise<boolean> => {
    if (savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    try {
      const settings = await window.api.updateSettings({ threadToolbarButtons: next })
      setButtons(normalizeToolbarButtons(settings.threadToolbarButtons))
      return true
    } catch (error) {
      toast(errorText(error), 'error')
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  const move = (index: number, offset: number) => {
    const next = [...buttons]
    ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
    void save(next)
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editing || !editing.name.trim() || !editing.program.trim()) return
    const existing = buttons.find((button) => button.id === editing.id)
    const button: CommandButton = {
      id: editing.id ?? randomId(), kind: 'command', visible: existing?.visible ?? true,
      name: editing.name.trim(), program: editing.program.trim(), args: toolbarArgumentLines(editing.args)
    }
    if (await save(existing ? buttons.map((item) => item.id === button.id ? button : item) : [...buttons, button])) setEditing(null)
  }

  if (window.api.isRemote) return null
  return (
    <div className="toolbar-settings">
      <h4>{t('顶部按钮')}</h4>
      <p className="muted small">{t('设置会话顶部按钮的显示和顺序。自定义命令在新的终端窗口运行，输出保留至按 Enter 关闭。')}</p>
      <div className="toolbar-settings-list" aria-label={t('顶部按钮顺序')}>
        {buttons.map((button, index) => {
          const name = button.kind === 'builtin' ? t(BUILTIN_NAMES[button.action]) : button.name
          return <div className="toolbar-settings-row" key={button.id}>
            <input className="toggle" type="checkbox" checked={button.visible} disabled={saving} aria-label={t('显示 {name}', { name })}
              onChange={(event) => void save(buttons.map((item) => item.id === button.id ? { ...item, visible: event.target.checked } : item))} />
            <div className="toolbar-settings-name">
              <span>{button.kind === 'command' && <IconTerminal size={14} />}{name}</span>
              {button.kind === 'command' && <code title={button.program}>{button.program}</code>}
            </div>
            <div className="toolbar-settings-controls">
              <button type="button" className="icon-btn tiny" title={t('上移')} aria-label={t('上移 {name}', { name })} disabled={saving || index === 0} onClick={() => move(index, -1)}><IconArrowUp size={14} /></button>
              <button type="button" className="icon-btn tiny" title={t('下移')} aria-label={t('下移 {name}', { name })} disabled={saving || index === buttons.length - 1} onClick={() => move(index, 1)}><IconArrowDown size={14} /></button>
              {button.kind === 'command' && <>
                <button type="button" className="icon-btn tiny" title={t('编辑')} aria-label={t('编辑 {name}', { name })} disabled={saving} onClick={() => setEditing({ id: button.id, name: button.name, program: button.program, args: button.args.join('\n') })}><IconEdit size={14} /></button>
                <button type="button" className="icon-btn tiny" title={t('删除')} aria-label={t('删除 {name}', { name })} disabled={saving} onClick={() => { void save(buttons.filter((item) => item.id !== button.id)).then((ok) => { if (ok && editing?.id === button.id) setEditing(null) }) }}><IconTrash size={14} /></button>
              </>}
            </div>
          </div>
        })}
      </div>
      {!editing && <button type="button" className="btn" disabled={saving} onClick={() => setEditing({ name: '', program: '', args: '' })}><IconPlus size={14} />{t('添加命令按钮')}</button>}
      {editing && <form className="toolbar-command-form" onSubmit={(event) => void submit(event)}>
        <h4>{editing.id ? t('编辑命令按钮') : t('添加命令按钮')}</h4>
        <label>{t('按钮名称')}<input className="input" autoFocus required value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} disabled={saving} /></label>
        <label>{t('程序路径')}<input className="input" required placeholder={t('绝对路径或 PATH 中的程序名')} value={editing.program} onChange={(event) => setEditing({ ...editing, program: event.target.value })} disabled={saving} spellCheck={false} /></label>
        <label>{t('参数（每行一个）')}<textarea className="input" rows={4} value={editing.args} onChange={(event) => setEditing({ ...editing, args: event.target.value })} disabled={saving} spellCheck={false} /></label>
        <p className="muted small">{t('每个非空行作为一个独立参数，无需给路径加引号。程序与参数支持 {cwd}（会话工作目录）和 {projectPath}（项目根目录）。默认在会话工作目录执行。')}</p>
        <div className="toolbar-command-form-actions">
          <button className="btn" type="button" disabled={saving} onClick={() => setEditing(null)}>{t('取消')}</button>
          <button className="btn primary" type="submit" disabled={saving || !editing.name.trim() || !editing.program.trim()}>{saving ? t('保存中…') : t('保存')}</button>
        </div>
      </form>}
    </div>
  )
}
