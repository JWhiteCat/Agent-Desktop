import { useT } from '../lib/i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitDiff, ThreadMeta } from '@shared/types'
import { DiffFileView, collectEditedFiles, collectGitFiles, type DiffFile } from '../lib/diff'
import { untrackedGitPaths } from '@shared/git-path'
import { useStore } from '../store'
import { IconBranch, IconRefresh, IconX, Spinner } from './icons'
import { ResizeHandle } from './ResizeHandle'

type Tab = 'thread' | 'git'

export function ChangesPanel({ thread, onClose }: { thread: ThreadMeta; onClose: () => void }) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('thread')
  const items = useStore((s) => s.items[thread.id])
  const running = useStore((s) => s.app.running.includes(thread.id))
  const project = useStore((s) => s.app.projects.find((p) => p.id === thread.projectId))
  const cwd = thread.cwd ?? project?.path ?? ''
  const [git, setGit] = useState<GitDiff | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!cwd) return
    setLoading(true)
    try {
      setGit(await window.api.gitDiff(cwd))
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    if (tab === 'git' && !running) refresh()
  }, [tab, running, refresh])

  const threadFiles = useMemo(() => collectEditedFiles(items ?? [], cwd), [items, cwd, t])

  const gitFiles = useMemo(() => {
    if (!git?.isRepo) return []
    return collectGitFiles(git)
  }, [git])

  const untracked = useMemo(
    () => new Set(untrackedGitPaths(git?.status ?? '')),
    [git]
  )

  const totals = (files: DiffFile[]) => files.reduce((a, f) => ({ add: a.add + f.added, del: a.del + f.removed }), { add: 0, del: 0 })
  const files = tab === 'thread' ? threadFiles : gitFiles
  const total = totals(files)

  return (
    <aside className="changes">
      <header className="changes-head drag">
        <div className="tabs no-drag">
          <button className={`tab ${tab === 'thread' ? 'active' : ''}`} onClick={() => setTab('thread')}>
            {t('本对话编辑')}
          </button>
          <button className={`tab ${tab === 'git' ? 'active' : ''}`} onClick={() => setTab('git')}>
            {t('Git 差异')}
          </button>
        </div>
        <div className="no-drag row-gap">
          {tab === 'git' && (
            <button className="icon-btn" title={t('刷新')} onClick={refresh} disabled={loading}>
              <IconRefresh size={14} className={loading ? 'spin' : ''} />
            </button>
          )}
          <button className="icon-btn" title={t('关闭')} onClick={onClose}>
            <IconX size={14} />
          </button>
        </div>
      </header>
      <div className="changes-summary">
        <span>{t('{count} 个文件', { count: files.length })}</span>
        {total.add > 0 && <span className="add">+{total.add}</span>}
        {total.del > 0 && <span className="del">−{total.del}</span>}
        {tab === 'git' && git?.branch && (
          <span className="badge">
            <IconBranch size={12} /> {git.branch}
          </span>
        )}
      </div>
      <div className="changes-body">
        {tab === 'git' && loading && !git && (
          <div className="center-hint">
            <Spinner />
          </div>
        )}
        {tab === 'git' && git && !git.isRepo && <div className="empty-hint">{t('当前目录不是 git 仓库')}</div>}
        {tab === 'git' && git?.error && <div className="notice error">{git.error}</div>}
        {files.length === 0 && (tab === 'thread' || git?.isRepo) && (
          <div className="empty-hint">{tab === 'thread' ? t('本对话还没有编辑文件') : t('工作区没有未提交的改动')}</div>
        )}
        {files.map((f) => (
          <DiffFileView
            key={f.path}
            file={untracked.has(f.path) && tab === 'git' ? { ...f, path: t('{path}（未跟踪）', { path: f.path }) } : f}
            defaultOpen={files.length <= 8}
          />
        ))}
      </div>
      {/* After the draggable header, so the handle stays clickable in the title-bar area. */}
      <ResizeHandle panel="changes" label={t('调整变更面板宽度')} />
    </aside>
  )
}
