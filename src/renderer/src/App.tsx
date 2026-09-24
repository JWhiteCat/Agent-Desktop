import { useEffect, useRef, useState } from 'react'
import { ChangesPanel } from './components/ChangesPanel'
import { ImportDialog, SettingsDialog } from './components/Dialogs'
import { Home } from './components/Home'
import { IconSidebar } from './components/icons'
import { Sidebar } from './components/Sidebar'
import { ThreadView } from './components/ThreadView'
import { goHome, useStore } from './store'

export default function App() {
  const view = useStore((s) => s.view)
  const thread = useStore((s) => (s.view.kind === 'thread' ? s.app.threads.find((t) => t.id === (s.view as { id: string }).id) : undefined))
  const toastMsg = useStore((s) => s.toast)
  const theme = useStore((s) => s.app.settings.theme)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [changesOpen, setChangesOpen] = useState(false)
  const [dialog, setDialog] = useState<'settings' | 'import' | null>(null)
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (view.kind === 'thread' && !thread) goHome()
  }, [view, thread])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const k = e.key.toLowerCase()
      if (k === 'n' && !e.shiftKey) {
        e.preventDefault()
        goHome()
      } else if (k === 'k' || (k === 'f' && e.shiftKey)) {
        e.preventDefault()
        setSidebarOpen(true)
        requestAnimationFrame(() => search.current?.focus())
      } else if (k === 'b') {
        e.preventDefault()
        setSidebarOpen((o) => !o)
      } else if (k === 'd' && e.shiftKey) {
        e.preventDefault()
        setChangesOpen((o) => !o)
      } else if (k === ',') {
        e.preventDefault()
        setDialog('settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const showChanges = changesOpen && !!thread && view.kind === 'thread'

  return (
    <div className={`app ${sidebarOpen ? '' : 'sidebar-hidden'} ${showChanges ? 'changes-open' : ''}`}>
      {sidebarOpen && <Sidebar ref={search} onOpenSettings={() => setDialog('settings')} onOpenImport={() => setDialog('import')} />}
      <button
        className="icon-btn sidebar-toggle no-drag"
        title={`${sidebarOpen ? '隐藏' : '显示'}侧边栏 (Ctrl+B)`}
        onClick={() => setSidebarOpen((o) => !o)}
      >
        <IconSidebar />
      </button>
      <main className="main">
        {view.kind === 'thread' && thread ? (
          <ThreadView thread={thread} changesOpen={changesOpen} onToggleChanges={() => setChangesOpen((o) => !o)} />
        ) : (
          <Home projectId={view.kind === 'home' ? view.projectId : undefined} onOpenImport={() => setDialog('import')} />
        )}
      </main>
      {showChanges && thread && <ChangesPanel thread={thread} onClose={() => setChangesOpen(false)} />}
      {dialog === 'settings' && <SettingsDialog onClose={() => setDialog(null)} onOpenImport={() => setDialog('import')} />}
      {dialog === 'import' && <ImportDialog onClose={() => setDialog(null)} />}
      {toastMsg && (
        <div key={toastMsg.id} className={`toast ${toastMsg.level}`}>
          {toastMsg.text}
        </div>
      )}
    </div>
  )
}
