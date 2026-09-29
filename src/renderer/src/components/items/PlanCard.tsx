import { useContext, useState } from 'react'
import type { ToolItem } from '@shared/types'
import { errorOf, planPath, planUriOf } from '../../lib/tools'
import { IconChevronDown, IconChevronRight, IconFile, IconList, Spinner } from '../icons'
import { Markdown } from './Markdown'
import { TurnActionsContext } from './TurnActions'

export function PlanCard({ item }: { item: ToolItem }) {
  const { buildPlan, planId } = useContext(TurnActionsContext)
  const [open, setOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const a = typeof item.args === 'object' && item.args ? item.args : {}
  const plan = typeof a.plan === 'string' ? a.plan.trim() : ''
  const todos: any[] = Array.isArray(a.todos) ? a.todos : []
  const uri = planUriOf(item)
  const running = item.status === 'running'
  const canBuild = !!buildPlan && planId === item.id && item.status === 'success'

  const build = async () => {
    if (!buildPlan || starting) return
    setStarting(true)
    try {
      await buildPlan(item)
    } catch {
      setStarting(false)
    }
  }

  return (
    <div className={`plan-card ${item.status === 'error' ? 'failed' : ''}`}>
      <div className="plan-head">
        <span className="step-icon">{running ? <Spinner size={12} /> : <IconList size={14} />}</span>
        <span className="plan-title">{a.name || (running ? '正在制定计划' : '计划')}</span>
        {uri && !window.api.isRemote && (
          <button className="icon-btn tiny" title="打开计划文件" onClick={() => window.api.openPath(planPath(uri))}>
            <IconFile size={13} />
          </button>
        )}
      </div>
      {a.overview && <div className="plan-overview">{a.overview}</div>}
      {todos.length > 0 && (
        <div className="todo-list plan-todos">
          {todos.map((t, i) => (
            <div key={t.id ?? i} className={`todo ${String(t.status ?? '').toLowerCase()}`}>
              <span className="todo-box">{/complete/i.test(t.status) ? '✓' : ''}</span>
              <span>{t.content ?? t.title ?? String(t.id ?? '')}</span>
            </div>
          ))}
        </div>
      )}
      {plan && (
        <>
          <button className="plan-toggle" onClick={() => setOpen((o) => !o)}>
            {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
            <span>{open ? '收起计划' : '查看完整计划'}</span>
          </button>
          {open && (
            <div className="plan-body">
              <Markdown text={plan} />
            </div>
          )}
        </>
      )}
      {item.status === 'error' && <div className="plan-error">{errorOf(item) ?? '计划创建失败'}</div>}
      {canBuild && (
        <div className="question-actions">
          <button type="button" className="question-submit" disabled={starting} onClick={build}>
            {starting ? '正在启动' : '执行计划'}
          </button>
          <span className="muted small">切换到 Agent 模式按计划实施</span>
        </div>
      )}
    </div>
  )
}
