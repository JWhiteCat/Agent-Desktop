import { localizedMessage, t as translate } from '@shared/i18n'
import type { CliProvider, Item, ResultItem } from '@shared/types'
import type { WeeklyQuotaEstimate } from '@shared/turn-quota'
import { exitFailureDetail } from '../cli'
import type { CodexTurnUsageReader } from '../codex-turn-usage'
import { newId } from '../id'
import type { StreamReducer } from '../reducer'
import { isCodexRoutingTimeout } from '../system-proxy'
import { automaticContinueNotice, automaticContinuePrompt, isAutomaticContinueFailure } from './auto-continue'
import { cliLabel } from './provider'
import { abandonQuestions } from './requests'

export interface FinalizeRunInput {
  items: Item[]
  reducer: StreamReducer
  provider: CliProvider
  model: string
  stopped: boolean
  autoContinue?: boolean
  wakeup?: boolean
  failText?: string
  verification?: { url?: string }
  stderr: string
  code: number | null
  spawnError?: Error
  resultId?: string
  timing?: ResultItem['timing']
  fileChanges?: ResultItem['fileChanges']
  codexUsage?: CodexTurnUsageReader
  weeklyQuotaEstimate?: WeeklyQuotaEstimate
  recover: boolean
}

export interface FinalizeRunOutput {
  changed: Item[]
  resultId?: string
  recover: boolean
  continuePrompt?: string
  recoverNotice?: string
  preview: string
  failed: boolean
  summary: string
}

/**
 * Pure turn-finalization pass that closes open segments, reconciles result timing /
 * file-change / quota metadata, appends the appropriate status notice, and computes
 * completion preview/failure metadata.
 */
export function finalizeTurnItems(input: FinalizeRunInput): FinalizeRunOutput {
  const { items, reducer: r, provider, model, stopped, wakeup, spawnError, fileChanges, timing } = input
  let resultId = input.resultId
  const changed: Item[] = [...r.closeSegments(), ...r.abortRunningTools(), ...abandonQuestions(items)]

  if (!r.gotResult) {
    const recorded = input.codexUsage?.read()
    if (recorded) {
      resultId = newId()
      changed.push(
        r.push({
          id: resultId,
          kind: 'result',
          isError: !stopped,
          cli: 'codex',
          model: r.init.model || recorded.model,
          createdAt: Date.now(),
          usageId: recorded.usageId,
          usage: recorded.usage,
          usageComplete: recorded.completed,
          ...(recorded.quotaSnapshot ? { quotaSnapshot: recorded.quotaSnapshot } : {})
        })
      )
    }
  }

  const ensureResult = (defaultModel: string, isError: boolean): ResultItem | undefined => {
    let existing = items.find((item): item is ResultItem => item.kind === 'result' && item.id === resultId)
    if (!existing) {
      resultId = newId()
      const created = r.push({
        id: resultId,
        kind: 'result',
        isError,
        cli: provider,
        model: defaultModel,
        createdAt: Date.now()
      })
      if (created.kind === 'result') existing = created
    }
    return existing
  }

  if (fileChanges !== undefined) {
    const result = ensureResult(r.init.model ?? '', !r.gotResult && !stopped)
    if (result) {
      if (wakeup && result.fileChanges?.length) {
        const merged = new Map(result.fileChanges.map((change) => [change.path, change]))
        for (const change of fileChanges) merged.set(change.path, change)
        result.fileChanges = [...merged.values()]
      } else {
        result.fileChanges = fileChanges
      }
      changed.push(result)
    }
  }

  if (timing) {
    const result = ensureResult(model, !stopped)
    if (result) {
      if (wakeup && result.durationMs !== undefined) {
        result.durationMs += Math.round(timing.elapsedMs)
        result.timing = {
          ...timing,
          elapsedMs: result.durationMs,
          firstTokenMs: result.timing?.firstTokenMs ?? timing.firstTokenMs,
          firstVisibleOutputMs: result.timing?.firstVisibleOutputMs ?? timing.firstVisibleOutputMs
        }
      } else {
        result.timing = timing
        result.durationMs = Math.round(timing.elapsedMs)
      }
      changed.push(result)
    }
  }

  const recover = input.recover
  const continuePrompt = recover ? automaticContinuePrompt() : undefined
  const recoverNotice = continuePrompt ? automaticContinueNotice(provider) : undefined

  if (input.verification && !stopped) {
    const result = ensureResult(model, true)
    if (result) {
      result.isError = true
      changed.push(result)
    }
    const verificationUrl = input.verification.url
    changed.push(r.push({
      id: newId(), kind: 'notice', level: 'error',
      ...(verificationUrl
        ? { verificationUrl, ...localizedMessage('请使用当前 Antigravity 账号完成验证，然后重试。') }
        : localizedMessage('请在终端打开 Antigravity CLI，按提示完成 Google 账号验证，然后重试。'))
    }))
  } else {
    appendTerminalNotice({
      items,
      reducer: r,
      changed,
      provider,
      stopped,
      spawnError,
      autoContinue: input.autoContinue,
      failText: input.failText,
      stderr: input.stderr,
      code: input.code,
      continuePrompt,
      recoverNotice
    })
  }

  if (resultId && input.weeklyQuotaEstimate) {
    const result = items.find((item): item is ResultItem => item.kind === 'result' && item.id === resultId)
    if (result) {
      result.weeklyQuotaEstimate = input.weeklyQuotaEstimate
      changed.push(result)
    }
  }

  const preview = (recoverNotice && continuePrompt ? translate(recoverNotice, { word: continuePrompt }) : r.lastAssistantText)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  const latestResult = [...items].reverse().find((it) => it.kind === 'result')
  const failed = !recover && (!!spawnError || !r.gotResult || (latestResult?.kind === 'result' && latestResult.isError))
  let summary = preview
  if (failed && !summary) {
    const notice = [...items].reverse().find((it) => it.kind === 'notice' && it.level === 'error')
    if (notice?.kind === 'notice') summary = notice.text.replace(/\s+/g, ' ').trim().slice(0, 120)
  }

  return { changed, resultId, recover, continuePrompt, recoverNotice, preview, failed, summary }
}

function appendTerminalNotice(params: {
  items: Item[]
  reducer: StreamReducer
  changed: Item[]
  provider: CliProvider
  stopped: boolean
  spawnError?: Error
  autoContinue?: boolean
  failText?: string
  stderr: string
  code: number | null
  continuePrompt?: string
  recoverNotice?: string
}): void {
  const { items, reducer: r, changed, provider, stopped, spawnError, autoContinue, failText, stderr, code, continuePrompt, recoverNotice } = params
  if (stopped) {
    changed.push(r.push({ id: newId(), kind: 'notice', level: 'info', ...localizedMessage('已停止') }))
    return
  }
  if (spawnError) {
    changed.push(
      r.push({
        id: newId(),
        kind: 'notice',
        level: 'error',
        ...localizedMessage('无法启动 {label}：{error}', { label: cliLabel(provider), error: spawnError.message })
      })
    )
    return
  }
  if (continuePrompt && recoverNotice) {
    const existing = [...items].reverse().find((item) => item.kind === 'result')
    if (existing?.kind === 'result' && existing.isError) {
      existing.isError = false
      changed.push(existing)
    }
    changed.push(r.push({ id: newId(), kind: 'notice', level: 'info', ...localizedMessage(recoverNotice, { word: continuePrompt }) }))
    return
  }
  if (autoContinue && r.gotResult && isAutomaticContinueFailure(provider, r.lastAssistantText)) {
    const existing = [...items].reverse().find((item) => item.kind === 'result')
    if (existing?.kind === 'result') {
      existing.isError = true
      changed.push(existing)
    }
    changed.push(r.push({ id: newId(), kind: 'notice', level: 'error', text: r.lastAssistantText.trim() }))
    return
  }
  if (!r.gotResult) {
    const detail = exitFailureDetail(failText, stderr)
    changed.push(
      r.push({
        id: newId(),
        kind: 'notice',
        level: 'error',
        ...(isCodexRoutingTimeout(detail)
          ? localizedMessage('Codex 工作区路由超时，请确认代理或 VPN 已启动后重试。')
          : detail
            ? { text: detail }
            : localizedMessage('{label} 意外退出（退出码 {code}）', { label: cliLabel(provider), code: code ?? 'unknown' }))
      })
    )
  }
}

/** Merges an Antigravity wakeup completion into the previous turn's result item (or creates one). */
export function mergeWakeupResult(params: {
  items: Item[]
  reducer: StreamReducer
  userItemId?: string
  model: string
  timing?: ResultItem['timing']
  preferUsage: (next: ResultItem['usage'], prev: ResultItem['usage']) => ResultItem['usage']
}): { resultId: string; item: Item } {
  const { items, reducer, userItemId, model, timing, preferUsage } = params
  const userIndex = userItemId ? items.findIndex((it) => it.id === userItemId) : -1
  let existing: ResultItem | undefined
  for (let i = items.length - 1; i > userIndex; i--) {
    const it = items[i]
    if (it.kind === 'result') {
      existing = it
      break
    }
  }
  const usage = preferUsage(reducer.lastUsage, existing?.usage)
  if (existing) {
    existing.isError = false
    if (timing) {
      existing.durationMs = (existing.durationMs ?? 0) + Math.round(timing.elapsedMs)
      existing.timing = {
        ...timing,
        elapsedMs: existing.durationMs,
        firstTokenMs: existing.timing?.firstTokenMs ?? timing.firstTokenMs,
        firstVisibleOutputMs: existing.timing?.firstVisibleOutputMs ?? timing.firstVisibleOutputMs
      }
    }
    if (usage) existing.usage = usage
    return { resultId: existing.id, item: existing }
  }
  const resultId = newId()
  const item = reducer.push({
    id: resultId,
    kind: 'result',
    isError: false,
    ...(timing ? { durationMs: Math.round(timing.elapsedMs), timing } : {}),
    createdAt: Date.now(),
    model,
    cli: 'antigravity',
    usageId: newId(),
    usage
  })
  return { resultId, item }
}
