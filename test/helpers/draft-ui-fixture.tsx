import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { DEFAULT_SETTINGS, type QuestionItem } from '../../src/shared/types'
import { Composer } from '../../src/renderer/src/components/Composer'
import { QuestionCard, StepItem, TurnActionsProvider } from '../../src/renderer/src/components/Items'
import { getState, setState, type SendOptions } from '../../src/renderer/src/store'
import { projectDraftScope, pruneDrafts, threadDraftScope } from '../../src/renderer/src/store/drafts'

const model = 'composer-2.5[fast=true]'
const initial: SendOptions = { model: 'auto', mode: 'agent', force: false, cli: 'cursor' }
const root = createRoot(document.getElementById('root')!)
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function eventually(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3_000
  while (!predicate() && Date.now() < deadline) await pause()
  check(predicate(), message)
}

function one<T extends Element = HTMLElement>(selector: string, container: ParentNode = document): T {
  const element = container.querySelector<T>(selector)
  check(element, `Missing element: ${selector}`)
  return element
}

async function render(node: ReactNode) {
  flushSync(() => root.render(<StrictMode>{node}</StrictMode>))
  await pause()
}

async function click(element: Element) {
  flushSync(() => (element as HTMLElement).click())
  await pause()
}

async function button(label: string, container: ParentNode = document) {
  const element = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === label)
  check(element, `Missing button: ${label}`)
  await click(element)
}

async function type(value: string, selector = '.composer textarea', container: ParentNode = document) {
  const input = one<HTMLTextAreaElement>(selector, container)
  // Calling the native setter bypasses React's value tracker, as a user edit does.
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
  flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })))
  await pause()
}

async function attach(name: string) {
  const input = one<HTMLInputElement>('.attachment-input')
  const transfer = new DataTransfer()
  transfer.items.add(new File(['draft bytes'], name, { type: 'text/plain' }))
  input.files = transfer.files
  flushSync(() => input.dispatchEvent(new Event('change', { bubbles: true })))
  await pause()
}

function value() { return one<HTMLTextAreaElement>('.composer textarea').value }

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function runDraftChecks() {
  const uploads: string[] = []
  window.api = {
    platform: 'win32',
    updateSettings: async () => undefined,
    updateProject: async () => undefined,
    uploadAttachment: async (request: { name: string; mimeType: string; data: string }) => {
      uploads.push(request.name)
      return { id: `upload-${uploads.length}`, name: request.name, mimeType: request.mimeType, size: 11 }
    }
  } as unknown as typeof window.api
  const state = getState()
  setState({
    app: { ...state.app,
      projects: ['fixture-project', 'project-a', 'project-b', 'same-id', 'background-defaults'].map(id => ({ id, name: id, path: id, createdAt: 0 })),
      threads: ['thread-a', 'thread-b', 'send-success', 'other-success', 'send-failure', 'other-failure', 'questions-a', 'questions-b', 'markdown-a', 'markdown-b', 'same-id', 'background-mode', 'background-cli']
        .map(id => ({ id, projectId: 'fixture-project', title: id, mode: 'agent', source: 'app', createdAt: 0, updatedAt: 0 })),
      settings: { ...DEFAULT_SETTINGS, language: 'zh-CN', cliProvider: 'cursor', favoriteModels: [] }
    },
    modelsByCli: { cursor: [{ id: 'auto', label: 'Auto' }, { id: model, label: 'Composer 2.5' }], codex: [], claude: [] }
  })
  const passed: string[] = []
  const sent: { text: string; opts: SendOptions }[] = []
  const send = async (text: string, opts: SendOptions) => { sent.push({ text, opts }) }
  // ThreadView and Home change the key when navigating, forcing a real unmount.
  const composer = (scope: string, onSend = send, options = initial) => <Composer key={scope} draftScope={scope}
    projectId={scope.startsWith('project:') ? scope.slice('project:'.length) : 'fixture-project'}
    initial={options} cli="cursor" showWorktree onCliChange={() => model}
    preserveChoicesOnRestore={scope.startsWith('project:')} onSend={onSend} />

  for (const [label, scope] of [['thread', threadDraftScope], ['project', projectDraftScope]] as const) {
    const a = scope(`${label}-a`), b = scope(`${label}-b`)
    await render(composer(a))
    await type(`${label} A`)
    await attach(`${label}.txt`)
    await button('Agent')
    // Select the labeled menu item rather than relying on the mode ordering.
    const plan = Array.from(document.querySelectorAll('.menu-item')).find(entry => entry.querySelector('.menu-label')?.textContent === 'Plan')
    check(plan, 'Plan mode is available')
    await click(plan)
    await button('默认权限')
    await button('本地')
    await click(one('.model-pill'))
    await button('Composer 2.5')
    // Clicking the selected pill closes the model popup before switching.
    await click(one('.model-pill'))
    await render(composer(b))
    check(value() === '', `${label} B starts with a distinct text draft`)
    check(!document.querySelector('.draft-attachment'), `${label} B starts without A's attachment`)
    await type(`${label} B`)
    await render(composer(a))
    check(value() === `${label} A`, `${label} A text survives unmount`)
    check(one('.attachment-name').textContent === `${label}.txt`, `${label} A attachment survives unmount`)
    check(document.body.textContent?.includes('Plan'), `${label} A mode survives unmount`)
    check(document.body.textContent?.includes('完全访问'), `${label} A permissions survive unmount`)
    check(document.body.textContent?.includes('Worktree'), `${label} A worktree survives unmount`)
    check(one('.model-pill').textContent?.includes('Composer'), `${label} A model survives stale initial props`)
    await click(one('.send-btn'))
    await eventually(() => value() === '', `${label} send completes`)
    check(sent.at(-1)?.text === `${label} A`, `${label} sends the restored text`)
    check(sent.at(-1)?.opts.model === model && sent.at(-1)?.opts.mode === 'plan' && sent.at(-1)?.opts.force && sent.at(-1)?.opts.worktree,
      `${label} sends the restored selections`)
    check(sent.at(-1)?.opts.attachmentIds?.length === 1, `${label} sends the restored File`)
    check(value() === '' && !document.querySelector('.draft-attachment'), `${label} successful send clears its draft`)
    await render(composer(b))
    check(value() === `${label} B`, `${label} B remains untouched by A's send`)
    passed.push(`${label} composers`)
  }

  for (const outcome of ['success', 'failure'] as const) {
    const a = threadDraftScope(`send-${outcome}`), b = threadDraftScope(`other-${outcome}`)
    const pending = deferred()
    const onSend = async () => pending.promise
    await render(composer(a, onSend))
    await type(`pending ${outcome}`)
    await attach(`pending-${outcome}.txt`)
    await click(one('.send-btn'))
    await render(composer(b))
    await type(`independent ${outcome}`)
    await render(composer(a, onSend))
    check(one<HTMLTextAreaElement>('.composer textarea').disabled, 'Remounted pending send remains disabled')
    await render(composer(b))
    if (outcome === 'success') pending.resolve()
    else pending.reject(new Error('fixture send failed'))
    check(value() === `independent ${outcome}`, 'Send completion does not edit the currently visible thread')
    await render(composer(a, onSend))
    await eventually(() => !one<HTMLTextAreaElement>('.composer textarea').disabled, 'Send completion unlocks its original composer')
    check(value() === (outcome === 'success' ? '' : 'pending failure'), 'Completion updates the unmounted original draft')
    check(!!document.querySelector('.draft-attachment') === (outcome === 'failure'), 'Only successful sends clear restored attachments')
    check(!!document.querySelector('[role="alert"]') === (outcome === 'failure'), 'Failed sends retain an error across remounts')
  }
  const deleted = threadDraftScope('deleted-thread')
  const oldSend = deferred()
  await render(composer(deleted, async () => oldSend.promise))
  await type('deleted draft')
  await click(one('.send-btn'))
  await render(null)
  pruneDrafts(getState().app)
  await render(composer(deleted))
  check(value() === '' && !one<HTMLTextAreaElement>('.composer textarea').disabled, 'Deleted scope starts with an empty draft')
  await type('new draft with reused id')
  oldSend.resolve()
  await pause()
  check(value() === 'new draft with reused id', 'Completion from a deleted draft cannot clear a newly created scope')
  await render(composer(threadDraftScope('same-id')))
  await type('conversation draft')
  await render(composer(projectDraftScope('same-id')))
  check(value() === '', 'Project and thread with the same id have different drafts')
  await type('project draft')
  await render(composer(threadDraftScope('same-id')))
  check(value() === 'conversation draft', 'Project draft never replaces an identically named thread')
  const background = threadDraftScope('background-mode')
  await render(composer(background, send, { ...initial, mode: 'plan' }))
  await type('preserve text while mode changes')
  await render(null)
  await render(composer(background, send, { ...initial, mode: 'agent' }))
  check(document.querySelector('.composer-left')?.textContent?.includes('Agent'), 'Background mode changes apply when the user has not changed the draft mode')
  check(value() === 'preserve text while mode changes', 'Background mode changes preserve text')
  await button('Agent')
  const ask = Array.from(document.querySelectorAll('.menu-item')).find(entry => entry.querySelector('.menu-label')?.textContent === 'Ask')
  check(ask, 'Ask mode is available')
  await click(ask)
  await render(null)
  await render(composer(background, send, { ...initial, mode: 'plan' }))
  check(document.querySelector('.composer-left')?.textContent?.includes('Ask'), 'Explicit unsent mode selection survives a background default update')
  const home = projectDraftScope('background-defaults')
  await render(composer(home, send, { ...initial, model, mode: 'plan', force: true }))
  await render(null)
  await render(composer(home))
  check(one('.model-pill').textContent?.includes('Composer') && document.body.textContent?.includes('Plan') && document.body.textContent?.includes('完全访问'),
    'Home selections survive defaults changed by another conversation')
  const switchedCli = threadDraftScope('background-cli')
  await render(composer(switchedCli, send, { ...initial, model }))
  await click(one('.model-pill'))
  await button('Auto')
  await render(null)
  await render(composer(switchedCli, send, { ...initial, model, cli: 'codex' }))
  check(document.querySelector('.composer-left')?.textContent?.includes('Codex'), 'Background CLI changes update the restored provider')
  await type('provider and model stay paired')
  await click(one('.send-btn'))
  await eventually(() => value() === '', 'Send after provider change completes')
  check(sent.at(-1)?.opts.cli === 'codex' && sent.at(-1)?.opts.model === model, 'A new provider replaces the previous provider\'s explicit model choice')
  passed.push('pending sends')

  const question: QuestionItem = {
    id: 'shared-question-id', kind: 'question', toolCallId: 'plan-review:fixture', purpose: 'codex-plan-review', status: 'pending',
    questions: [{ id: 'q', prompt: 'Review plan', options: [
      { id: 'implement_plan', label: 'Implement' }, { id: 'revise_plan', label: 'Revise' }
    ] }]
  }
  const card = (threadId: string, item = question) => <QuestionCard key={threadId} threadId={threadId} item={item} />
  await render(card('questions-a'))
  await button('否，先修改计划')
  await type('先补充迁移步骤', '.question-other-input')
  await render(card('questions-b'))
  check(!document.querySelector('.question-opt.selected'), 'Same question id in another thread has independent options')
  await button('是，执行此计划')
  await render(card('questions-a'))
  check(one<HTMLTextAreaElement>('.question-other-input').value === '先补充迁移步骤', 'Plan feedback survives a thread switch')
  check(one('.question-opt.selected').textContent?.includes('否，先修改计划'), 'Plan choice survives a thread switch')
  await render(card('questions-a', { ...question, status: 'answered', answers: [{ questionId: 'q', selectedOptionIds: ['implement_plan'] }] }))
  check(one('.question-opt.selected').textContent?.includes('是，执行此计划'), 'Recorded answers override cached draft choices')
  check(!document.querySelector('.question-other-input'), 'Recorded answers hide stale plan feedback')
  const build = deferred()
  const plan = <TurnActionsProvider value={{ planId: 'plan', buildPlan: () => build.promise }}>
    <StepItem threadId="questions-a" item={{ id: 'plan', kind: 'tool', callId: 'plan-call', tool: 'createPlan', status: 'success', startedAt: 0, args: { plan: 'Plan details' } }} />
  </TurnActionsProvider>
  await render(plan)
  await button('查看完整计划')
  await button('执行计划')
  await render(null)
  await render(plan)
  check(!!document.querySelector('.plan-body'), 'Expanded plan survives unmount')
  check(one<HTMLButtonElement>('.question-submit').disabled, 'Pending plan execution remains locked after remount')
  build.resolve()
  await eventually(() => !one<HTMLButtonElement>('.question-submit').disabled, 'Successful plan execution releases its cached pending state')
  passed.push('question cards')

  const body = JSON.stringify({ questions: [{ id: 'q', prompt: 'Pick a path', options: ['First', 'Second'] }] })
  const block = '```questions\n' + body + '\n```'
  const message = (threadId: string, id = 'message') => <TurnActionsProvider key={threadId + id} value={{ reply: async () => undefined }}>
    <StepItem threadId={threadId} item={{ id, kind: 'assistant', text: `${block}\n\n${block}` }} />
  </TurnActionsProvider>
  await render(message('markdown-a'))
  const cards = () => Array.from(document.querySelectorAll('.question-card'))
  check(cards().length === 2, 'Both identical question blocks render')
  await button('其他（手动输入）', cards()[0])
  await type('custom path', '.question-other-input', cards()[0])
  await button('Second', cards()[1])
  await render(message('markdown-b'))
  check(!document.querySelector('.question-opt.selected'), 'Markdown answers are isolated by thread')
  await render(message('markdown-a', 'different-message'))
  check(!document.querySelector('.question-opt.selected'), 'Markdown answers are isolated by message')
  await render(message('markdown-a'))
  check(one<HTMLTextAreaElement>('.question-other-input', cards()[0]).value === 'custom path', 'Markdown custom text survives unmount')
  check(one('.question-opt.selected', cards()[1]).textContent?.includes('Second'), 'Second identical block retains its own choice')
  check(!cards()[1].querySelector('.question-other-input'), 'Identical blocks never share custom answer state')
  passed.push('markdown questions')
  root.unmount()
  return passed
}
