import { useMemo } from 'react'
import { quoteModel } from '@shared/model-prices'
import type { CliProvider, ModelInfo, ResultItem } from '@shared/types'
import { compactNumber, duration, formatUsd } from '../../lib/format'
import { groupModels, modelCaption } from '../../lib/models'
import { HoverTip } from '../HoverTip'
import { CopyButton } from './primitives'

export interface ResultFooterProps {
  item: ResultItem
  text?: string
  fallbackModel?: string
  cli?: CliProvider
}

/** The model catalog is supplied by the caller so rendering is independent of the store. */
export function ResultFooter({ item, text, fallbackModel, cli = 'cursor', models }: ResultFooterProps & { models: ModelInfo[] }) {
  const provider = item.cli ?? cli
  const groups = useMemo(() => groupModels(models), [models])
  const u = item.usage
  const tokens = u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) : 0
  const modelId = item.model || fallbackModel || ''
  const caption = modelId ? modelCaption(groups, modelId) : ''
  const quote = modelId && u ? quoteModel(modelId, u, provider) : undefined
  const priceSource = provider === 'codex' ? 'OpenAI API 公开标价' : 'Cursor 公开标价'
  const sessionUsage = provider === 'codex' ? sessionConsumption(item) : undefined
  const turnEstimate = provider === 'codex' && item.weeklyQuotaEstimate !== undefined ? weeklyEstimate(item) : undefined
  return (
    <div className="result-footer">
      {text && <CopyButton text={text} />}
      {item.durationMs !== undefined && <span>{duration(item.durationMs)}</span>}
      {tokens > 0 && (
        <HoverTip text={`输入 ${u?.inputTokens ?? 0} · 输出 ${u?.outputTokens ?? 0} · 缓存读 ${u?.cacheReadTokens ?? 0} · 缓存写 ${u?.cacheWriteTokens ?? 0}`}>
          {compactNumber(tokens)} tokens
        </HoverTip>
      )}
      {caption && <HoverTip text={caption === modelId ? undefined : modelId}>{caption}</HoverTip>}
      {quote && (
        <HoverTip text={quote.costUsd == null ? 'Auto 和价目表没有的模型未计入费用' : `估算 $${quote.costUsd}（${priceSource}）`}>
          {formatUsd(quote.costUsd)}
        </HoverTip>
      )}
      {sessionUsage && <HoverTip text={sessionUsage.title}>{sessionUsage.text}</HoverTip>}
      {turnEstimate && <HoverTip text={turnEstimate.title}>{turnEstimate.text}</HoverTip>}
    </div>
  )
}

function weeklyEstimate(item: ResultItem): { text: string; title: string } {
  const estimate = item.weeklyQuotaEstimate
  const amount = estimate?.usedPercent
  const start = estimate?.start?.weekly?.usedPercent
  const end = estimate?.end?.weekly?.usedPercent
  const reading = (value: number | undefined) => validQuotaAmount(value) ? `${quotaAmount(value)}%` : '暂无数据'
  return {
    text: `本轮预估消耗 ${validQuotaAmount(amount) ? `周额度 ${quotaAmount(amount)}%` : '暂无数据'}`,
    title: `周额度已用：开始 ${reading(start)}，结束 ${reading(end)}。计算：结束 − 开始。${validQuotaAmount(amount) ? '' : '缺少有效读数或无法确认同一周额度周期，暂不能估算。'}账号其他会话、其他客户端的使用和统计延迟可能影响估算。0% 表示读数未变化，不代表本轮没有消耗。`
  }
}

function sessionConsumption(item: ResultItem): { text: string; title: string } {
  const usage = item.codexSessionUsage
  const sampled = usage?.dataAsOf ? ` 服务统计时间：${usage.dataAsOf}` : ''
  if (usage?.status === 'available' || usage?.status === 'partial') {
    const amounts: string[] = []
    if (validQuotaAmount(usage.weekly)) amounts.push(`周额度 ${quotaAmount(usage.weekly)}%`)
    if (validQuotaAmount(usage.fiveHour)) amounts.push(`5小时额度 ${quotaAmount(usage.fiveHour)}%`)
    const credits = balanceCreditsText(usage.balanceCredits)
    if (credits !== undefined && (credits !== '0' || !amounts.length)) amounts.push(`${credits} credits`)
    if (amounts.length) {
      const partial = usage.status === 'partial'
      return {
        text: `本次会话消耗 ${amounts.join(' · ')}${partial ? '（统计中）' : ''}`,
        title: `Codex 按当前会话单独统计在当前额度周期内的累计消耗，不受其他会话影响。${partial ? '统计仍在更新，当前数值尚未完整。' : '服务端统计可能延迟。'}${sampled}`
      }
    }
  }
  const legacy = item.codexThreadUsage
  if (validQuotaAmount(legacy?.credits)) {
    const cost = validQuotaAmount(legacy.costUsd) ? ` / ${formatUsd(legacy.costUsd)}` : ''
    return {
      text: `本次会话消耗 ${quotaAmount(legacy.credits)} credits${cost}`,
      title: `Codex 返回的当前会话累计额度消耗估算，单位为 credits，不受其他会话影响。金额仅在 Codex 返回时显示。${sampled}`
    }
  }
  return {
    text: `本次会话消耗 ${usage ? '服务未返回' : '暂无数据'}`,
    title: `${usage ? 'Codex 尚未返回此会话的可用额度数据，无法确认是统计延迟还是当前会话不受支持。' : '尚未获得当前会话的额度消耗数据。'}已记录的 token 和公开价格估算仍可参考。${sampled}`
  }
}

function balanceCreditsText(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length > 128 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return undefined
  // Inspect the mantissa so tiny nonzero decimal strings cannot underflow to zero.
  return /[1-9]/.test(value.split(/[eE]/)[0]) ? value : '0'
}

function quotaAmount(value: number): string {
  return value > 0 && value < 0.0001 ? '<0.0001' : String(Number(value.toFixed(4)))
}

function validQuotaAmount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}
