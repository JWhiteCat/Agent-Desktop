import { dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { BUILTIN_SKINS, DEFAULT_SKIN, normalizeSkin, normalizeSkins, type SkinConfig } from '@shared/skins'
import { skinsFor } from '../skins'
import type { Handler } from '../remote'
import type { IpcDeps } from './deps'
import { t } from '@shared/i18n'

export function skinHandlers(deps: IpcDeps): Record<string, Handler> {
  const choose = async (directory: boolean) => {
    const options: Electron.OpenDialogOptions = {
      title: t(directory ? '选择 Web 项目或壁纸库目录' : '选择背景文件或 project.json'),
      properties: [directory ? 'openDirectory' : 'openFile'],
      ...(!directory ? { filters: [{ name: t('壁纸素材'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'mp4', 'webm', 'html', 'htm', 'json'] }] } : {})
    }
    const win = deps.getWindow()
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? undefined : result.filePaths[0]
  }
  return {
    'skin:pick': async (directory = false) => {
      const input = await choose(directory === true)
      return input ? skinsFor(deps.store).add(input) : null
    },
    'skin:scan': async (manual = false) => {
      const root = manual === true ? await choose(true) : undefined
      if (manual === true && !root) return null
      return skinsFor(deps.store).scan(root)
    },
    'skin:source': (id: string) => skinsFor(deps.store).source(id),
    'skin:save': (value: SkinConfig) => {
      const skin = normalizeSkin(value)
      if (!skin.id || BUILTIN_SKINS.some(s => s.id === skin.id)) skin.id = randomUUID()
      const skins = normalizeSkins([...deps.store.settings.skins.filter(s => s.id !== skin.id), skin])
      deps.store.updateSettings({ skins, skin })
      deps.broadcast()
      return skin
    },
    'skin:delete': (id: string) => {
      if (BUILTIN_SKINS.some(s => s.id === id)) throw new Error(t('不能删除内置皮肤。'))
      deps.store.updateSettings({ skins: deps.store.settings.skins.filter(s => s.id !== id), ...(deps.store.settings.skin.id === id ? { skin: { ...DEFAULT_SKIN } } : {}) })
      deps.broadcast()
    }
  }
}
