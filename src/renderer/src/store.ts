/** Public store API. Feature modules depend on state.ts directly, never on this facade. */
export { getState, setState, useStore } from './store/state'
export type { SendOptions, UIState, View } from './store/state'
export { initStore } from './store/init'
export { cliCommands, loadSkillCommands, prepareCommands, skillCommands } from './store/commands'
export { chatModel, rememberModel, rememberModelVariant, setDefaultModel, setFavoriteModels } from './store/model-preferences'
export { loadModels, setCliProvider } from './store/models'
export { errorText, toast } from './store/feedback'
export {
  addProjectInteractive,
  answerQuestion,
  collapseAllProjects,
  forkThread,
  goHome,
  openGrokBot,
  openNextRunningThread,
  openNextUnreadThread,
  openThread,
  rememberProject,
  removeQueued,
  reorderQueued,
  sendMessage,
  sendQueuedNow,
  startThread,
  syncThreadFromCli
} from './store/threads'
