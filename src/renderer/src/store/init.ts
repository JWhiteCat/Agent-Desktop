import { receiveCommands } from './commands'
import { loadModels } from './models'
import { LAST_PROJECT_KEY, LEGACY_MODEL_KEY } from './persistence'
import { getState, setState } from './state'
import { openThread, receiveItems } from './threads'

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

  window.api.onState((app) => setState({ app }))
  window.api.onFocusThread((id) => {
    void openThread(id)
  })
  window.api.onEvent((ev) => {
    if (ev.type === 'items') {
      receiveItems(ev.threadId, ev.items)
    } else if (ev.type === 'commands') {
      receiveCommands(ev.threadId, ev.commands)
    } else if (ev.type === 'running' && !ev.running) {
      const v = getState().view
      if (v.kind === 'thread' && v.id === ev.threadId && document.hasFocus()) {
        window.api.updateThread(ev.threadId, { unread: false })
      }
    }
  })

  void loadModels()
}
