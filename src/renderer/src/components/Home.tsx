import { useEffect, useRef, useState } from 'react'
import { normalizeCliProvider } from '@shared/types'
import { relativeTime, shortPath } from '../lib/format'
import { defaultModelFor, favoritesFor, modelForChat, projectModelFor } from '../lib/model-prefs'
import { addProjectInteractive, chatModel, cliCommands, goHome, openThread, setCliProvider, startThread, useStore } from '../store'
import { Composer, type ComposerHandle } from './Composer'
import { IconChevronDown, IconFolder, IconImport, IconPlus } from './icons'
import { MenuList, Popover } from './Menu'

const SUGGESTIONS = [
  '梳理这个项目的整体架构，并指出关键模块',
  '找出代码里潜在的 bug 并修复最严重的一个',
  '为最近改动的模块补充单元测试',
  '检查依赖和构建配置，给出升级建议'
]

export function Home({ projectId, onOpenImport }: { projectId?: string; onOpenImport: () => void }) {
  const projects = useStore((s) => s.app.projects)
  const threads = useStore((s) => s.app.threads)
  const settings = useStore((s) => s.app.settings)
  const cli = normalizeCliProvider(settings.cliProvider)
  const slashCommands = useStore((s) => cliCommands(s, cli))
  const models = useStore((s) => s.modelsByCli[cli] ?? s.models)
  const project = projects.find((p) => p.id === projectId) ?? projects[0]
  const composer = useRef<ComposerHandle>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerBtn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    composer.current?.focus()
  }, [project?.id])

  const recent = project
    ? threads
        .filter((t) => t.projectId === project.id && !t.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 3)
    : []

  return (
    <div className="home">
      <header className="main-header drag" />
      <div className="home-center">
        <div className="home-logo">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M12 2 3 7v10l9 5 9-5V7Z" />
            <path d="M3 7l9 5 9-5M12 12v10" />
          </svg>
        </div>
        <h2 className="home-title">要构建点什么？</h2>
        {projects.length === 0 ? (
          <div className="home-empty">
            <p className="muted">先添加一个项目文件夹，Agent 将在该目录中工作。</p>
            <div className="home-empty-actions">
              <button className="btn primary" onClick={() => addProjectInteractive().then((id) => id && goHome(id))}>
                <IconPlus size={14} /> 添加项目
              </button>
              <button className="btn" onClick={onOpenImport}>
                <IconImport size={14} /> 导入 Cursor CLI 历史
              </button>
            </div>
          </div>
        ) : (
          <>
            <button ref={pickerBtn} className="project-picker" onClick={() => setPickerOpen((o) => !o)} title={project?.path}>
              <IconFolder size={15} />
              <span>{project?.name}</span>
              <span className="muted small">{project && shortPath(project.path)}</span>
              <IconChevronDown size={12} />
            </button>
            <Popover anchor={pickerBtn.current} open={pickerOpen} onClose={() => setPickerOpen(false)}>
              <MenuList
                onClose={() => setPickerOpen(false)}
                items={[
                  ...projects.map((p) => ({
                    label: p.name,
                    hint: shortPath(p.path),
                    icon: <IconFolder size={14} />,
                    checked: p.id === project?.id,
                    onSelect: () => goHome(p.id)
                  })),
                  'separator' as const,
                  {
                    label: '添加项目…',
                    icon: <IconPlus size={14} />,
                    onSelect: () => addProjectInteractive().then((id) => id && goHome(id))
                  }
                ]}
              />
            </Popover>
          </>
        )}
      </div>

      {project && (
        <div className="home-bottom">
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggestion" onClick={() => composer.current?.setText(s)}>
                {s}
              </button>
            ))}
          </div>
          <div className="composer-dock">
            <Composer
              key={project.id}
              ref={composer}
              projectId={project.id}
              cli={cli}
              cliNote="新建对话使用的 CLI。已有对话不会跟着改。"
              onCliChange={(next) => {
                setCliProvider(next)
                return chatModel(project.id, next)
              }}
              showWorktree={cli === 'cursor'}
              initial={{
                model: modelForChat(models, favoritesFor(settings, cli), defaultModelFor(settings, cli), projectModelFor(project, cli)),
                mode: settings.defaultMode,
                force: settings.force,
                worktree: false,
                cli
              }}
              commands={slashCommands}
              placeholder={
                slashCommands.length
                  ? `在 ${project.name} 中让 Agent 做点什么… 输入 / 查看命令`
                  : `在 ${project.name} 中让 Agent 做点什么…`
              }
              onSend={async (text, opts) => {
                await startThread(project.id, text, opts)
              }}
            />
          </div>
          {recent.length > 0 && (
            <div className="recent">
              <div className="recent-title muted small">最近的对话</div>
              {recent.map((t) => (
                <button key={t.id} className="recent-item" onClick={() => openThread(t.id)}>
                  <span className="recent-name">{t.title}</span>
                  <span className="muted small">{relativeTime(t.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
