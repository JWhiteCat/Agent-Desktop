import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DesktopApi } from '@shared/api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: DesktopApi = {
  platform: process.platform,
  isRemote: false,
  getState: () => ipcRenderer.invoke('state:get'),
  pickProject: () => ipcRenderer.invoke('project:pick'),
  addProject: (p) => ipcRenderer.invoke('project:add', p),
  updateProject: (id, patch) => ipcRenderer.invoke('project:update', id, patch),
  removeProject: (id) => ipcRenderer.invoke('project:remove', id),
  reorderProjects: (ids) => ipcRenderer.invoke('project:reorder', ids),
  createThread: (projectId, mode, model, force, cli) => ipcRenderer.invoke('thread:create', projectId, mode, model, force, cli),
  updateThread: (id, patch) => ipcRenderer.invoke('thread:update', id, patch),
  deleteThread: (id) => ipcRenderer.invoke('thread:delete', id),
  forkThread: (id, throughItemId) => ipcRenderer.invoke('thread:fork', id, throughItemId),
  getItems: (id) => ipcRenderer.invoke('thread:items', id),
  syncFromCli: (id) => ipcRenderer.invoke('thread:syncFromCli', id),
  send: (req) => ipcRenderer.invoke('agent:send', req),
  uploadAttachment: (req) => ipcRenderer.invoke('attachment:upload', req),
  readAttachment: (id) => ipcRenderer.invoke('attachment:read', id),
  openAttachment: (id) => ipcRenderer.invoke('attachment:open', id),
  prepareCommands: (threadId, opts) => ipcRenderer.invoke('agent:prepare', threadId, opts),
  stop: (id) => ipcRenderer.invoke('agent:stop', id),
  answerQuestion: (threadId, questionId, answers) => ipcRenderer.invoke('agent:answerQuestion', threadId, questionId, answers),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  usageSummary: (period) => ipcRenderer.invoke('usage:summary', period),
  usageQuotas: () => ipcRenderer.invoke('usage:quotas'),
  consumeCodexReset: (creditId) => ipcRenderer.invoke('usage:consumeCodexReset', creditId),
  listModels: (refresh, provider) => ipcRenderer.invoke('cli:models', refresh, provider),
  cliInfo: (provider) => ipcRenderer.invoke('cli:info', provider),
  login: (provider) => ipcRenderer.invoke('cli:login', provider),
  updateCli: (provider) => ipcRenderer.invoke('cli:update', provider),
  scanCliSessions: () => ipcRenderer.invoke('cli:scan'),
  importCliSessions: (ids) => ipcRenderer.invoke('cli:import', ids),
  gitDiff: (cwd) => ipcRenderer.invoke('git:diff', cwd),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openSkillsDir: () => ipcRenderer.invoke('shell:openSkills'),
  localMcpList: () => ipcRenderer.invoke('local:mcpList'),
  localMcpSave: (req) => ipcRenderer.invoke('local:mcpSave', req),
  localMcpToggle: (id, enabled, hash) => ipcRenderer.invoke('local:mcpToggle', id, enabled, hash),
  localMcpDelete: (id, hash) => ipcRenderer.invoke('local:mcpDelete', id, hash),
  localSkillList: () => ipcRenderer.invoke('local:skillList'),
  localSkillRead: (id) => ipcRenderer.invoke('local:skillRead', id),
  localSkillSave: (req) => ipcRenderer.invoke('local:skillSave', req),
  localSkillToggle: (id, enabled) => ipcRenderer.invoke('local:skillToggle', id, enabled),
  localSkillDelete: (id) => ipcRenderer.invoke('local:skillDelete', id),
  openInEditor: (p) => ipcRenderer.invoke('shell:openInEditor', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  remoteInfo: () => ipcRenderer.invoke('remote:info'),
  resetRemoteToken: () => ipcRenderer.invoke('remote:resetToken'),
  onEvent: (cb) => subscribe('agent:event', cb),
  onState: (cb) => subscribe('state:changed', cb),
  onFocusThread: (cb) => subscribe('thread:focus', cb)
}

contextBridge.exposeInMainWorld('api', api)
