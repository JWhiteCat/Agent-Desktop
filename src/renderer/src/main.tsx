import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { createWebApi } from './lib/web-api'
import { getState, goHome, initStore, openThread } from './store'
import './styles.css'

if (!window.api) window.api = createWebApi()
document.documentElement.dataset.platform = window.api.platform
if (window.api.isRemote) document.documentElement.dataset.remote = ''

/** Remote links carry `#thread=<id>` or `#project=<id>` for the view open on the desktop. */
function openFromHash(): void {
  const hash = new URLSearchParams(location.hash.slice(1))
  const threadId = hash.get('thread')
  const projectId = hash.get('project')
  if (!threadId && !projectId) return
  history.replaceState(null, '', location.pathname + location.search)
  const { app } = getState()
  if (threadId && app.threads.some((t) => t.id === threadId)) void openThread(threadId)
  else if (projectId && app.projects.some((p) => p.id === projectId)) goHome(projectId)
}

initStore()
  .then(() => {
    openFromHash()
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  })
  .catch((err) => {
    document.getElementById('root')!.textContent = `无法连接 Agent Desktop：${err instanceof Error ? err.message : String(err)}`
  })
