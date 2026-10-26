import { useMemo } from 'react'
import { t } from '@shared/i18n'
import { quoteModel } from '@shared/model-prices'
import { visibleOutputTps } from '@shared/turn-performance'
import { weeklyQuotaEstimate } from '@shared/turn-quota'
import type { CliProvider, ModelInfo, ResultItem } from '@shared/types'
import { compactNumber, duration, formatUsd } from '../../lib/format'
import { groupModels, modelCaption } from '../../lib/models'
import { useT } from '../../lib/i18n'
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
  const t = useT()
  const provider = item.cli ?? cli
  const groups = useMemo(() => groupModels(models), [models])
  const u = item.usage
  const counts = [u?.inputTokens, u?.outputTokens, u?.cacheReadTokens, u?.cacheWriteTokens]
  const knownCounts = counts.filter(validQuotaAmount)
  const tokens = knownCounts.reduce((sum, value) => sum + value, 0)
  const countText = (value: number | undefined) => validQuotaAmount(value) ? String(value) : t('未提供')
  const tokenDetail = t('输入 {input} · 输出 {output} · 缓存读 {read} · 缓存写 {write}', {
    input: countText(u?.inputTokens), output: countText(u?.outputTokens),
    read: countText(u?.cacheReadTokens), write: countText(u?.cacheWriteTokens)
  }) + '. ' + t('输入不含单列的缓存读写；输出使用服务返回的计数，可能包含隐藏思考和工具调用。缺失字段不是零。')
  const rate = visibleOutputTps(item)
  const first = item.timing?.firstVisibleOutputMs
  const elapsed = item.timing?.elapsedMs
  const validFirst = validQuotaAmount(first) && validQuotaAmount(elapsed) && first <= elapsed
  const ttft = t('首字延迟 {value}', { value: validFirst ? duration(Math.round(first)) : t('暂无数据') })
  const ttftDetail = t('从发送本轮提示到收到第一段非空助手正文的客户端延迟；不把思考、工具事件或隐藏推理当作首字。包含网络、排队、思考和此前的工具等待，不是 prefill 耗时。历史记录或没有正文时暂无数据。')
  const rateLabel = t('可见输出 TPS（估算）{value}', { value: rate === undefined ? t('暂无数据') : `${rate > 0 && rate < 0.01 ? '<0.01' : Number(rate.toFixed(2))} token/s` })
  const rateDetail = t('用 cl100k_base 估算助手正文 tokens，不使用服务计费计数。对每段首个接收批次之后拼接的正文分词，估算 tokens 除以各段首末接收时间之和；至少两个接收批次且相隔 100ms 才计入。消息、思考或工具事件分段，段间等待不计；无消息 ID 时按连续正文分段，不保证对应模型请求。受网络与 CLI 缓冲影响，不是模型原生 tokenizer 或服务端 decode TPS。取消、失败或没有足够流式样本时暂无数据；服务 usage 缺失不影响估算。')
  const backendLabel = t('服务端 Prefill / Decode：未提供')
  const backendDetail = t('当前 CLI 未提供服务端 prefill 和 decode 分阶段耗时。可见输出 TPS 是独立的客户端流式估算，不代表服务端算力；首字延迟也不能代替 prefill 耗时。缓存命中不表示重新处理了这些输入 tokens。')
  const modelId = item.model || fallbackModel || ''
  const caption = modelId ? modelCaption(groups, modelId) : ''
  const quote = modelId && u ? quoteModel(item.apiModel || modelId, u, provider) : undefined
  const priceSource = provider === 'codex' ? t('OpenAI API 公开标价') : provider === 'claude' ? t('Anthropic API 公开标价') : t('Cursor 公开标价')
  const sessionUsage = provider === 'codex' ? sessionConsumption(item) : undefined
  const turnEstimate = provider === 'codex' && item.weeklyQuotaEstimate !== undefined ? weeklyEstimate(item) : undefined
  return (
    <div className="result-footer">
      {text && <CopyButton text={text} />}
      {item.durationMs !== undefined && <span>{duration(item.durationMs)}</span>}
      <MetricDetail text={tokenDetail}>
        {knownCounts.length ? `${compactNumber(tokens)} tokens${knownCounts.length < 4 ? t('（部分）') : ''}${item.usageComplete === false ? t('（统计中）') : ''}` : t('tokens 暂无数据')}
      </MetricDetail>
      <MetricDetail text={ttftDetail}>{ttft}</MetricDetail>
      <MetricDetail text={rateDetail}>{rateLabel}</MetricDetail>
      <MetricDetail text={backendDetail}>{backendLabel}</MetricDetail>
      {caption && <HoverTip text={caption === modelId ? undefined : modelId}>{caption}</HoverTip>}
      {quote && (
        <HoverTip text={quote.costUsd == null ? t('Auto 和价目表没有的模型未计入费用') : t('估算 ${cost}（{source}）', { cost: quote.costUsd, source: priceSource })}>
          {formatUsd(quote.costUsd)}
        </HoverTip>
      )}
      {sessionUsage && <HoverTip text={sessionUsage.title}>{sessionUsage.text}</HoverTip>}
      {turnEstimate && <HoverTip text={turnEstimate.title}>{turnEstimate.text}</HoverTip>}
    </div>
  )
}

/** Native title and a focusable, named trigger keep metric definitions available without a mouse. */
function MetricDetail({ text, children }: { text: string; children: string }) {
  return <HoverTip text={text}><span role="note" tabIndex={0} title={text} aria-label={`${children}. ${text}`}>{children}</span></HoverTip>
}

function weeklyEstimate(item: ResultItem): { text: string; title: string } {
  const estimate = item.weeklyQuotaEstimate
  // Older results may have complete readings but no difference because reset times drifted.
  const amount = validQuotaAmount(estimate?.usedPercent)
    ? estimate.usedPercent
    : weeklyQuotaEstimate(estimate?.start, estimate?.end).usedPercent
  const start = estimate?.start?.weekly?.usedPercent
  const end = estimate?.end?.weekly?.usedPercent
  const reading = (value: number | undefined) => validQuotaAmount(value) ? `${quotaAmount(value)}%` : t('暂无数据')
  return {
    text: t('本轮预估周额度 {amount}', { amount: validQuotaAmount(amount) ? `${quotaAmount(amount)}%` : t('暂无数据') }),
    title: t('周额度已用：开始 {start}，结束 {end}。计算：结束 − 开始。{unavailable}账号其他会话、其他客户端的使用和统计延迟可能影响估算。0% 表示读数未变化，不代表本轮没有消耗。', {
      start: reading(start), end: reading(end),
      unavailable: validQuotaAmount(amount) ? '' : t('缺少有效读数或无法确认同一周额度周期，暂不能估算。')
    })
  }
}

function sessionConsumption(item: ResultItem): { text: string; title: string } {
  const usage = item.codexSessionUsage
  const sampled = usage?.dataAsOf ? t(' 服务统计时间：{time}', { time: usage.dataAsOf }) : ''
  if (usage?.status === 'available' || usage?.status === 'partial') {
    const amounts: string[] = []
    if (validQuotaAmount(usage.weekly)) amounts.push(`${quotaAmount(usage.weekly)}%`)
    if (validQuotaAmount(usage.fiveHour)) amounts.push(t('5小时额度 {amount}%', { amount: quotaAmount(usage.fiveHour) }))
    const credits = balanceCreditsText(usage.balanceCredits)
    if (credits !== undefined && (credits !== '0' || !amounts.length)) amounts.push(`${credits} credits`)
    if (amounts.length) {
      const partial = usage.status === 'partial'
      return {
        text: t('本轮周额度 {amount}{partial}', { amount: amounts.join(' · '), partial: partial ? t('（统计中）') : '' }),
        title: t('Codex 按当前会话单独统计在当前额度周期内的累计消耗，不受其他会话影响。{status}{sampled}', {
          status: partial ? t('统计仍在更新，当前数值尚未完整。') : t('服务端统计可能延迟。'), sampled
        })
      }
    }
  }
  const legacy = item.codexThreadUsage
  if (validQuotaAmount(legacy?.credits)) {
    const cost = validQuotaAmount(legacy.costUsd) ? ` / ${formatUsd(legacy.costUsd)}` : ''
    return {
      text: t('本轮周额度 {amount}{partial}', { amount: `${quotaAmount(legacy.credits)} credits${cost}`, partial: '' }),
      title: t('Codex 返回的当前会话累计额度消耗估算，单位为 credits，不受其他会话影响。金额仅在 Codex 返回时显示。{sampled}', { sampled })
    }
  }
  return {
    text: t('本轮周额度 {amount}{partial}', { amount: usage ? t('服务未返回') : t('暂无数据'), partial: '' }),
    title: t('{status}已记录的 token 和公开价格估算仍可参考。{sampled}', {
      status: usage ? t('Codex 尚未返回此会话的可用额度数据，无法确认是统计延迟还是当前会话不受支持。') : t('尚未获得当前会话的额度消耗数据。'), sampled
    })
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
