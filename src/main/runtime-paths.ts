import * as electron from 'electron'
import os from 'node:os'
import path from 'node:path'

export const APP_DIR_NAME = 'Agent Desktop'

function electronApp(): { getPath?: (name: 'userData' | 'appData') => string } | undefined {
  if (!electron || typeof electron !== 'object') return undefined
  const app = (electron as { app?: { getPath?: (name: 'userData' | 'appData') => string } }).app
  return app && typeof app.getPath === 'function' ? app : undefined
}

/** Platform-native AppData / config root directory without requiring Electron. */
export function resolveAppDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string {
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim()
    return appData || path.join(home, 'AppData', 'Roaming')
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support')
  }
  const xdg = env.XDG_CONFIG_HOME?.trim()
  return xdg || path.join(home, '.config')
}

/** Platform-native Electron `userData` directory, honoring `AGENT_DESKTOP_USER_DATA`. */
export function resolveUserDataDir(
  overrideUserData?: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): string {
  const custom = overrideUserData?.trim() || env.AGENT_DESKTOP_USER_DATA?.trim()
  if (custom) return path.resolve(custom)
  return path.join(resolveAppDataDir(platform, env, home), APP_DIR_NAME)
}

/** Resolves `userData` via Electron when running inside Electron main, or via Node fallback in headless CLI. */
export function getRuntimeUserDataDir(overrideUserData?: string): string {
  if (overrideUserData?.trim()) return path.resolve(overrideUserData.trim())
  const app = electronApp()
  if (app?.getPath) return app.getPath('userData')
  return resolveUserDataDir()
}

/** Resolves `appData` via Electron when running inside Electron main, or via Node fallback in headless CLI. */
export function getRuntimeAppDataDir(): string {
  const app = electronApp()
  if (app?.getPath) return app.getPath('appData')
  return resolveAppDataDir()
}

/** Resolves the persistent `data` directory under `userData`. */
export function getRuntimeDataDir(overrideUserData?: string): string {
  return path.join(getRuntimeUserDataDir(overrideUserData), 'data')
}
