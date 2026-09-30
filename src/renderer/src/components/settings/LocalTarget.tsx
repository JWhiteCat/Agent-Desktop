import type { LocalTarget } from '@shared/local-config'
import { normalizeCliProvider, type CliProvider } from '@shared/types'
import { useT } from '../../lib/i18n'
import { useStore } from '../../store'

export const CLI_ORDER: CliProvider[] = ['cursor', 'codex', 'claude']
export const CLI_LABEL: Record<CliProvider, string> = { cursor: 'Cursor', codex: 'Codex', claude: 'Claude' }

export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

export function TargetPicker({ target, onChange }: { target: LocalTarget; onChange: (target: LocalTarget) => void }) {
  const t = useT()
  const projects = useStore((s) => s.app.projects)
  const scopeValue = target.scope === 'user' ? '' : target.projectPath ?? ''
  return (
    <>
      <label className="stack-field">
        <span>CLI</span>
        <select className="input" value={target.cli} onChange={(e) => onChange({ ...target, cli: normalizeCliProvider(e.target.value) })}>
          {CLI_ORDER.map((cli) => (
            <option key={cli} value={cli}>
              {CLI_LABEL[cli]}
            </option>
          ))}
        </select>
      </label>
      <label className="stack-field">
        <span>{t('作用域')}</span>
        <select
          className="input"
          value={scopeValue}
          onChange={(e) => onChange(e.target.value ? { ...target, scope: 'project', projectPath: e.target.value } : { cli: target.cli, scope: 'user' })}
        >
          <option value="">{t('用户（所有项目）')}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.path}>
              {t('项目：{name}', { name: p.name })}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}
