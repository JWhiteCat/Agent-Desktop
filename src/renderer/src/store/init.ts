import { enableRemoteViewSync, publishRemoteView, restoreRemoteView } from '../lib/view-route'
import { receiveCommands } from './commands'
import { errorText, toast } from './feedback'
import { loadModels } from './models'
import { LAST_PROJECT_KEY, LEGACY_MODEL_KEY, REMOTE_VIEW_KEY } from './persistence'
import { setState, type View } from './state'
import { markDisplayedThreadRead, openThread, receiveItems, refreshThreadItems } from './threads'

/** Bootstrap state and route bridge events to the module that owns each update. */
export async function initStore(): Promise<void> {
  let app = await window.api.getState()
  const saved = localStorage.getItem(LAST_PROJECT_KEY) ?? undefined
  const lastProjectId = app.projects.some((p) => p.id === saved) ? saved : app.projects[0]?.id
  const legacyModel = localStorage.getItem(LEGACY_MODEL_KEY)
  if (legacyModel) {
    localStorage.removeItem(LEGACY_MODEL_KEY)
    if (legacyModel !== app.settings.defaultModel) {
      app = { ...app, settings: { ...app.settings, defaultModel: legacyModel } }
      void window.api.updateSettings({ defaultModel: legacyModel })
    }
  }
  const home: View = { kind: 'home', projectId: lastProjectId }
  const view = window.api.isRemote
    ? restoreRemoteView(location.hash, localStorage.getItem(REMOTE_VIEW_KEY), app) ?? home
    : home
  setState({ app, lastProjectId, view })
  if (window.api.isRemote) {
    publishRemoteView(view)
    enableRemoteViewSync()
  }
  if (view.kind === 'thread') void openThread(view.id).catch((err) => toast(errorText(err), 'error'))

  window.api.onState((app) => {
    setState({ app })
    void markDisplayedThreadRead()
  })
  window.addEventListener('focus', () => void markDisplayedThreadRead())
  document.addEventListener('visibilitychange', () => void markDisplayedThreadRead())
  window.api.onReconnect?.(() => {
    void refreshThreadItems().catch((err) => toast(errorText(err), 'error'))
  })
  window.api.onFocusThread((id) => {
    void openThread(id).catch((err) => toast(errorText(err), 'error'))
  })
  window.api.onEvent((ev) => {
    if (ev.type === 'items') {
      receiveItems(ev.threadId, ev.items)
    } else if (ev.type === 'commands') {
      receiveCommands(ev.threadId, ev.commands)
    } else if (ev.type === 'running' && !ev.running) {
      void markDisplayedThreadRead()
    }
  })

  void loadModels()
}
