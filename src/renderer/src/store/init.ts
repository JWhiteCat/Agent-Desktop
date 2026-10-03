import { receiveCommands } from './commands'
import { errorText, toast } from './feedback'
import { loadModels } from './models'
import { LAST_PROJECT_KEY, LEGACY_MODEL_KEY } from './persistence'
import { setState } from './state'
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
  setState({ app, lastProjectId, view: { kind: 'home', projectId: lastProjectId } })

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
