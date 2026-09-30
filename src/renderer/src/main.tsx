import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getLocale, setLanguage, subscribeLocale, t } from '@shared/i18n'
import App from './App'
import { createWebApi } from './lib/web-api'
import { getState, goHome, initStore, openThread } from './store'
import './styles.css'

setLanguage('system', navigator.language)
const applyDocumentLanguage = () => { document.documentElement.lang = getLocale() }
applyDocumentLanguage()
subscribeLocale(applyDocumentLanguage)
window.addEventListener('languagechange', () => {
  const { app } = getState()
  setLanguage(app.settings.language, app.systemLocale ?? navigator.language)
})

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
    document.getElementById('root')!.textContent = t('无法连接 Agent Desktop：{error}', { error: err instanceof Error ? err.message : String(err) })
  })
