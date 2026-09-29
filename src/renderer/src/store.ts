/** Public store API. Feature modules depend on state.ts directly, never on this facade. */
export { getState, setState, useStore } from './store/state'
export type { SendOptions, UIState, View } from './store/state'
export { initStore } from './store/init'
export { cliCommands, prepareCommands } from './store/commands'
export { chatModel, rememberModel, setDefaultModel, setFavoriteModels } from './store/model-preferences'
export { loadModels, setCliProvider } from './store/models'
export { errorText, toast } from './store/feedback'
export {
  addProjectInteractive,
  answerQuestion,
  forkThread,
  goHome,
  openThread,
  rememberProject,
  sendMessage,
  startThread,
  syncThreadFromCli
} from './store/threads'
