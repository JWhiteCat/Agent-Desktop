import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { catalogFromStorageJson, type CatalogModel } from '@shared/model-catalog'

const STORAGE_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'

function stateDbPath(): string {
  return path.join(app.getPath('appData'), 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return ''
}

/** Cursor's model catalog lists every context size; `agent models` collapses them onto one slug. */
export function loadCursorModelCatalog(): CatalogModel[] {
  const file = stateDbPath()
  if (!fs.existsSync(file)) return []
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(STORAGE_KEY) as { value?: unknown } | undefined
      return catalogFromStorageJson(asText(row?.value))
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}
