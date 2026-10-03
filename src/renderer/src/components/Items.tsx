import type { Item, QuestionItem } from '@shared/types'
import { answerQuestion, useStore } from '../store'
import { useT } from '../lib/i18n'
import { AssistantMessage, Notice, ThinkingBlock } from './items/Messages'
import { PlanCard } from './items/PlanCard'
import { QuestionForm } from './items/Questions'
import { ResultFooter as ResultFooterView, type ResultFooterProps } from './items/ResultFooter'
import { ToolRow } from './items/ToolRow'

// Keep the existing entry point; store access stays in these adapters.
export { Markdown } from './items/Markdown'
export { AssistantMessage, Notice, ThinkingBlock, UserMessage } from './items/Messages'
export { ToolRow } from './items/ToolRow'
export { TurnActionsProvider, type TurnActions } from './items/TurnActions'

export function ResultFooter(props: ResultFooterProps) {
  const provider = props.item.cli ?? props.cli ?? 'cursor'
  const models = useStore((s) => s.modelsByCli[provider])
  return <ResultFooterView {...props} models={models} />
}

export function QuestionCard({ item, threadId }: { item: QuestionItem; threadId: string }) {
  const t = useT()
  const pending = item.status === 'pending'
  const legacyOptions = item.questions.length === 1 ? item.questions[0].options : []
  const planReview = item.purpose === 'codex-plan-review' || (
    item.toolCallId.startsWith('plan-review:') && legacyOptions.length === 2 &&
    legacyOptions.some((option) => option.id === 'implement_plan') &&
    legacyOptions.some((option) => option.id === 'revise_plan')
  )
  const questions = planReview ? item.questions.map((question) => ({
    ...question,
    prompt: t('是否执行此计划？'),
    options: question.options.map((option) => option.id === 'implement_plan'
      ? { ...option, label: t('是，执行此计划') }
      : option.id === 'revise_plan'
        ? { ...option, label: t('否，先修改计划'), requiresText: true }
        : option)
  })) : item.questions
  return (
    <QuestionForm
      title={planReview ? t('是否执行此计划？') : item.title}
      questions={questions}
      feedbackPlaceholder={planReview ? t('请输入希望 Codex 如何修改计划') : undefined}
      answers={item.status === 'answered' ? item.answers : undefined}
      status={pending ? undefined : item.status === 'answered' ? t('已提交') : t('已跳过')}
      onSubmit={pending ? (answers) => answerQuestion(threadId, item.id, answers) : undefined}
      onSkip={pending ? () => answerQuestion(threadId, item.id, null) : undefined}
    />
  )
}

export function StepItem({
  item,
  streaming,
  threadId,
  onFork
}: {
  item: Item
  streaming?: boolean
  threadId?: string
  onFork?: () => void
}) {
  switch (item.kind) {
    case 'assistant':
      return <AssistantMessage text={item.text} streaming={streaming} onFork={onFork} />
    case 'thinking':
      return <ThinkingBlock item={item} />
    case 'tool':
      return item.tool === 'createPlan' ? <PlanCard item={item} /> : <ToolRow item={item} />
    case 'question':
      return threadId ? <QuestionCard item={item} threadId={threadId} /> : null
    case 'notice':
      return <Notice item={item} />
    default:
      return null
  }
}
