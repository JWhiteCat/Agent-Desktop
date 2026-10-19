import { useT } from '../lib/i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitDiff, ThreadMeta } from '@shared/types'
import { DiffFileView, collectEditedFiles, collectGitFiles, collectSnapshotTurns, type DiffFile } from '../lib/diff'
import { untrackedGitPaths } from '@shared/git-path'
import { useStore } from '../store'
import { IconBranch, IconRefresh, IconX, Spinner } from './icons'
import { BinaryFilesGroup } from './BinaryFilesGroup'
import { ResizeHandle } from './ResizeHandle'

type Tab = 'thread' | 'snapshot' | 'git'

function ChangesFileList({ files, tab, untracked, snapshotId }: { files: DiffFile[]; tab: Tab; untracked: Set<string>; snapshotId?: string }) {
  const t = useT()
  const [binaryOpen, setBinaryOpen] = useState<Record<Tab, boolean>>({ thread: false, snapshot: false, git: false })
  const [binarySnapshotId, setBinarySnapshotId] = useState(snapshotId)
  if (binarySnapshotId !== snapshotId) {
    setBinarySnapshotId(snapshotId)
    setBinaryOpen((open) => ({ ...open, snapshot: false }))
  }
  const textFiles = files.filter((file) => !file.binary)
  const binaryFiles = files.filter((file) => file.binary)
  const renderFile = (file: DiffFile) => (
    <DiffFileView
      key={file.path}
      file={file}
      label={tab === 'git' && untracked.has(file.path) ? t('{path}（未跟踪）', { path: file.path }) : undefined}
      defaultOpen={files.length <= 8}
    />
  )

  return (
    <>
      {textFiles.map(renderFile)}
      <BinaryFilesGroup
        count={binaryFiles.length}
        open={binaryOpen[tab]}
        onToggle={() => setBinaryOpen((open) => ({ ...open, [tab]: !open[tab] }))}
      >
        {binaryFiles.map(renderFile)}
      </BinaryFilesGroup>
    </>
  )
}

export function ChangesPanel({ thread, onClose }: { thread: ThreadMeta; onClose: () => void }) {
  return <ChangesPanelBody key={thread.id} thread={thread} onClose={onClose} />
}

function ChangesPanelBody({ thread, onClose }: { thread: ThreadMeta; onClose: () => void }) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('thread')
  const items = useStore((s) => s.items[thread.id])
  const running = useStore((s) => s.app.running.includes(thread.id))
  const project = useStore((s) => s.app.projects.find((p) => p.id === thread.projectId))
  const cwd = thread.cwd ?? project?.path ?? ''
  const [git, setGit] = useState<GitDiff | null>(null)
  const [loading, setLoading] = useState(false)
  // null follows the newest completed turn; explicit history selection stays pinned.
  const [selectedSnapshot, setSelectedSnapshot] = useState<string | null>(null)
  const snapshots = useMemo(() => collectSnapshotTurns(items ?? [], cwd, running), [items, cwd, running])
  const snapshot = snapshots.find((turn) => turn.id === selectedSnapshot) ?? snapshots[snapshots.length - 1]

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
  const files = tab === 'thread' ? threadFiles : tab === 'snapshot' ? snapshot?.files ?? [] : gitFiles
  const total = totals(files)

  return (
    <aside className="changes">
      <header className="changes-head drag">
        <div className="tabs no-drag">
          <button className={`tab ${tab === 'thread' ? 'active' : ''}`} onClick={() => setTab('thread')}>
            {t('本对话编辑')}
          </button>
          <button className={`tab ${tab === 'snapshot' ? 'active' : ''}`} onClick={() => setTab('snapshot')}>
            {t('快照差异')}
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
      {tab === 'snapshot' && (
        <div className="snapshot-controls">
          <label>
            {t('查看轮次')}
            <select aria-label={t('查看轮次')} value={selectedSnapshot && snapshots.some((turn) => turn.id === selectedSnapshot) ? selectedSnapshot : ''}
              onChange={(event) => setSelectedSnapshot(event.target.value || null)}>
              <option value="">{t('最近完成的一轮')}</option>
              {[...snapshots].reverse().map((turn) => (
                <option key={turn.id} value={turn.id}>{t('第 {number} 轮', { number: turn.number })}{turn.summary ? ` · ${turn.summary}` : ''}</option>
              ))}
            </select>
          </label>
          <div className="muted">{t('此处比较本轮运行前后的工作区内容，可能包含其他软件的修改。')}</div>
        </div>
      )}
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
        {tab === 'snapshot' && files.length === 0 && (
          <div className="empty-hint">{snapshot?.files === undefined ? t('本轮未记录快照') : t('本轮没有快照差异')}</div>
        )}
        {files.length === 0 && (tab === 'thread' || (tab === 'git' && git?.isRepo)) && (
          <div className="empty-hint">{tab === 'thread' ? t('本对话还没有编辑文件') : t('工作区没有未提交的改动')}</div>
        )}
        <ChangesFileList key={thread.id} files={files} tab={tab} untracked={untracked} snapshotId={snapshot?.id} />
      </div>
      {/* After the draggable header, so the handle stays clickable in the title-bar area. */}
      <ResizeHandle panel="changes" label={t('调整变更面板宽度')} />
    </aside>
  )
}
