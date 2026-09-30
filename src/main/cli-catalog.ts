import { t as translate } from '@shared/i18n'
import type { CliInfo, ModelInfo } from '@shared/types'
import { mergeModelLists } from '@shared/model-catalog'
import { parseModels, resolveApiKey, resolveCli, runCliOnce } from './cli'
import { claudeLogin, claudeStatus, claudeVersion, listClaudeModels, resolveClaude, resolveClaudeApiKey } from './claude'
import { codexLogin, codexStatus, codexVersion, listCodexModels, resolveCodex, resolveCodexApiKey } from './codex'
import { loadCursorModelCatalog } from './model-catalog'

export async function cursorModelList(agentPath: string, apiKeySetting: string): Promise<ModelInfo[]> {
  const cli = resolveCli(agentPath)
  if (!cli) return [{ id: 'auto', label: 'Auto' }]
  const apiKey = resolveApiKey(apiKeySetting)
  const res = await runCliOnce(cli, ['models'], 60_000, apiKey)
  const models = mergeModelLists(parseModels(res.stdout), loadCursorModelCatalog())
  return models.length ? models : [{ id: 'auto', label: 'Auto' }]
}

export async function codexModelList(codexPath: string, codexApiKey: string): Promise<ModelInfo[]> {
  return (await listCodexModels(codexPath, resolveCodexApiKey(codexApiKey))).models
}

export async function cursorCliInfo(agentPath: string, apiKeySetting: string): Promise<CliInfo> {
  const cursor = resolveCli(agentPath)
  if (!cursor) return { found: false }
  const apiKey = resolveApiKey(apiKeySetting)
  const [version, status] = await Promise.all([
    runCliOnce(cursor, ['--version']),
    runCliOnce(cursor, ['status'], 60_000, apiKey || undefined)
  ])
  return {
    found: true,
    path: cursor.display,
    version: version.stdout.trim() || version.stderr.trim(),
    status: (status.stdout + status.stderr).trim(),
    hasApiKey: !!apiKey
  }
}

export async function codexCliInfo(codexPath: string, codexApiKey: string): Promise<CliInfo> {
  const codex = resolveCodex(codexPath)
  if (!codex) return { found: false }
  const [version, status] = await Promise.all([codexVersion(codex), codexStatus(codex)])
  return {
    found: true,
    path: codex.display,
    version,
    status,
    hasApiKey: !!resolveCodexApiKey(codexApiKey),
    bundled: codex.bundled
  }
}

export async function claudeModelList(claudePath: string, claudeApiKey: string): Promise<ModelInfo[]> {
  return (await listClaudeModels(claudePath, resolveClaudeApiKey(claudeApiKey))).models
}

export async function claudeCliInfo(claudePath: string, claudeApiKey: string): Promise<CliInfo> {
  const claude = resolveClaude(claudePath)
  if (!claude) return { found: false }
  const [version, status] = await Promise.all([claudeVersion(claude), claudeStatus(claude)])
  return {
    found: true,
    path: claude.display,
    version,
    status,
    hasApiKey: !!resolveClaudeApiKey(claudeApiKey),
    bundled: claude.bundled
  }
}

export async function loginCursor(agentPath: string): Promise<string> {
  const cursor = resolveCli(agentPath)
  if (!cursor) throw new Error(translate('未找到 Cursor CLI'))
  const res = await runCliOnce(cursor, ['login'], 5 * 60_000, false)
  return (res.stdout + res.stderr).trim()
}

export async function loginCodex(codexPath: string): Promise<string> {
  const codex = resolveCodex(codexPath)
  if (!codex) throw new Error(translate('未找到 Codex CLI'))
  return codexLogin(codex)
}

export async function loginClaude(claudePath: string): Promise<string> {
  const claude = resolveClaude(claudePath)
  if (!claude) throw new Error(translate('未找到 Claude Code'))
  return claudeLogin(claude)
}
