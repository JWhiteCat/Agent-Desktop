/**
 * Minimal stub aliased to `'electron'` when bundling the standalone `cli.cjs` entrypoint.
 * Under `ELECTRON_RUN_AS_NODE=1`, Electron modules are unavailable and packaged builds do not ship
 * `node_modules/electron`, so this stub ensures no runtime `require('electron')` is emitted.
 */
export const app = undefined
export const net = undefined
export const dialog = undefined
export const shell = undefined
export const clipboard = undefined
export const ClipboardItem = undefined
export const nativeImage = undefined
export const BrowserWindow = undefined
export const ipcMain = undefined
export const Menu = undefined
export const nativeTheme = undefined
export const protocol = undefined
export const session = undefined
export const Notification = undefined
