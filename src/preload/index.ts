import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DesktopApi } from '@shared/api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: DesktopApi = {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('state:get'),
  pickProject: () => ipcRenderer.invoke('project:pick'),
  addProject: (p) => ipcRenderer.invoke('project:add', p),
  updateProject: (id, patch) => ipcRenderer.invoke('project:update', id, patch),
  removeProject: (id) => ipcRenderer.invoke('project:remove', id),
  reorderProjects: (ids) => ipcRenderer.invoke('project:reorder', ids),
  createThread: (projectId, mode, model) => ipcRenderer.invoke('thread:create', projectId, mode, model),
  updateThread: (id, patch) => ipcRenderer.invoke('thread:update', id, patch),
  deleteThread: (id) => ipcRenderer.invoke('thread:delete', id),
  getItems: (id) => ipcRenderer.invoke('thread:items', id),
  syncFromCli: (id) => ipcRenderer.invoke('thread:syncFromCli', id),
  send: (req) => ipcRenderer.invoke('agent:send', req),
  stop: (id) => ipcRenderer.invoke('agent:stop', id),
  answerQuestion: (threadId, questionId, answers) => ipcRenderer.invoke('agent:answerQuestion', threadId, questionId, answers),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  listModels: (refresh) => ipcRenderer.invoke('cli:models', refresh),
  cliInfo: () => ipcRenderer.invoke('cli:info'),
  login: () => ipcRenderer.invoke('cli:login'),
  scanCliSessions: () => ipcRenderer.invoke('cli:scan'),
  importCliSessions: (ids) => ipcRenderer.invoke('cli:import', ids),
  gitDiff: (cwd) => ipcRenderer.invoke('git:diff', cwd),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openInEditor: (p) => ipcRenderer.invoke('shell:openInEditor', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onEvent: (cb) => subscribe('agent:event', cb),
  onState: (cb) => subscribe('state:changed', cb),
  onFocusThread: (cb) => subscribe('thread:focus', cb)
}

contextBridge.exposeInMainWorld('api', api)
