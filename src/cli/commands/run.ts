import {
  threadCli,
  type AppState,
  type Item,
  type QuestionAnswer,
  type QuestionItem,
  type SendDelivery,
  type SendRequest,
  type ThreadMeta
} from '@shared/types'
import { promptQuestionInteractively } from '../prompt-ui'
import { StreamRenderer } from '../stream-render'
import {
  CliError,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_QUESTION_REQUIRED,
  EXIT_SIGINT,
  EXIT_USAGE,
  type CliIo,
  type CliRuntime,
  type OutputFormat,
  type QuestionPolicy
} from '../types'
import {
  defaultModelForProvider,
  parseMode,
  parseProvider,
  readStdinText,
  resolveOrCreateProject,
  uploadLocalFiles,
  writeJson
} from './helpers'

export interface RunCommandOptions {
  format: OutputFormat
  quiet?: boolean
  project?: string
  thread?: string
  cli?: string
  model?: string
  mode?: string
  force?: boolean
  worktree?: boolean
  files?: string[]
  queue?: boolean
  now?: boolean
  detach?: boolean
  showThinking?: boolean
  onQuestion?: QuestionPolicy
  promptFlag?: string
}

function isThreadBusy(state: AppState, threadId: string): boolean {
  if (state.running.includes(threadId) || (state.starting ?? []).includes(threadId)) return true
  const q = state.queued?.[threadId]
  return !!(q && q.items.length > 0 && !q.paused && !q.waitingForPlan)
}

export async function runPromptCommand(
  runtime: CliRuntime,
  io: CliIo,
  positionals: string[],
  opts: RunCommandOptions
): Promise<number> {
  if (opts.queue && opts.now) {
    throw new CliError('Cannot combine --queue and --now', EXIT_USAGE)
  }
  if (opts.detach && runtime.mode === 'headless') {
    throw new CliError(
      '--detach requires a running Agent Desktop instance (cannot detach in headless mode because the process would exit immediately).',
      EXIT_USAGE
    )
  }

  let prompt = opts.promptFlag ?? positionals.join(' ')
  if (!prompt.trim()) {
    prompt = (await readStdinText(io)).trim()
  }
  if (!prompt.trim()) {
    throw new CliError('Prompt is required. Pass it as an argument, via --prompt, or via stdin.', EXIT_USAGE)
  }

  const state = await runtime.call<AppState>('state:get')
  let thread: ThreadMeta
  let createdNewThread = false

  if (opts.thread) {
    const found = state.threads.find((t) => t.id === opts.thread)
    if (!found) throw new CliError(`Thread not found: ${opts.thread}`, EXIT_USAGE)
    thread = found
  } else {
    const project = await resolveOrCreateProject(runtime, state, opts.project, io.cwd(), true)
    const provider = parseProvider(opts.cli, state.settings.cliProvider)
    const mode = parseMode(opts.mode, state.settings.defaultMode)
    const model = opts.model ?? defaultModelForProvider(state.settings, provider)
    const force = opts.force ?? state.settings.force
    thread = await runtime.call<ThreadMeta>('thread:create', project.id, mode, model, force, provider)
    createdNewThread = true
  }

  const provider = opts.cli ? parseProvider(opts.cli, threadCli(thread)) : threadCli(thread)
  const mode = opts.mode ? parseMode(opts.mode, thread.mode) : thread.mode
  const model = opts.model ?? (provider === threadCli(thread) ? (thread.model || defaultModelForProvider(state.settings, provider)) : defaultModelForProvider(state.settings, provider))
  const force = opts.force ?? thread.force ?? state.settings.force
  const attachmentIds = opts.files?.length ? await uploadLocalFiles(runtime, opts.files, io.cwd()) : undefined
  const delivery: SendDelivery | undefined = opts.now ? 'now' : opts.queue ? 'queue' : undefined

  const req: SendRequest = {
    threadId: thread.id,
    prompt,
    ...(attachmentIds?.length ? { attachmentIds } : {}),
    model,
    mode,
    force,
    ...(opts.worktree ? { worktree: true } : {}),
    cli: provider,
    ...(delivery ? { delivery } : {})
  }

  if (opts.detach) {
    await runtime.call('agent:send', req)
    const info = {
      threadId: thread.id,
      projectId: thread.projectId,
      created: createdNewThread,
      cli: provider,
      mode,
      model,
      detached: true,
      modeRuntime: runtime.mode
    }
    if (opts.format === 'json' || opts.format === 'jsonl') writeJson(io, info)
    else io.stdout.write(`${thread.id}\n`)
    return EXIT_OK
  }

  const baselineItems = createdNewThread ? [] : await runtime.call<Item[]>('thread:items', thread.id)
  const questionPolicy: QuestionPolicy = opts.onQuestion ?? (io.stdin.isTTY ? 'interactive' : 'fail')

  let interrupted = false
  let questionExitItem: QuestionItem | undefined
  let resolveRun!: () => void
  let rejectRun!: (err: Error) => void
  const donePromise = new Promise<void>((resolve, reject) => {
    resolveRun = resolve
    rejectRun = reject
  })

  let settled = false
  const settle = (err?: Error) => {
    if (settled) return
    settled = true
    if (err) rejectRun(err)
    else resolveRun()
  }

  let latestState: AppState = state
  let sawActive = false
  let sendReturned = false
  let handlingQuestion = false

  const renderer = new StreamRenderer({
    format: opts.format,
    quiet: opts.quiet,
    showThinking: opts.showThinking,
    io,
    baselineIds: baselineItems.map((i) => i.id),
    onQuestion: (qItem) => {
      if (handlingQuestion) return
      handlingQuestion = true
      void (async () => {
        try {
          if (questionPolicy === 'cancel') {
            await runtime.call('agent:answerQuestion', thread.id, qItem.id, null)
            handlingQuestion = false
            return
          }
          if (questionPolicy === 'fail') {
            questionExitItem = qItem
            if (runtime.mode === 'headless') {
              await runtime.call('agent:answerQuestion', thread.id, qItem.id, null).catch(() => {})
            }
            settle()
            return
          }
          const answers = await promptQuestionInteractively(qItem, io)
          await runtime.call('agent:answerQuestion', thread.id, qItem.id, answers)
          handlingQuestion = false
        } catch (err) {
          settle(err instanceof Error ? err : new Error(String(err)))
        }
      })()
    }
  })

  if (opts.format === 'jsonl') {
    renderer.emitJsonl({
      type: 'run.start',
      threadId: thread.id,
      projectId: thread.projectId,
      cli: provider,
      mode,
      model,
      runtimeMode: runtime.mode
    })
  } else if (opts.format === 'text' && !opts.quiet) {
    io.stderr.write(`[thread] ${thread.id} (${provider} · ${mode}${model ? ` · ${model}` : ''} · ${runtime.mode})\n`)
  }

  const unsubscribe = await runtime.subscribe({
    onEvent: (event) => {
      if (event.threadId !== thread.id) return
      if (event.type === 'items') {
        renderer.onItems(event.items)
      } else if (event.type === 'running') {
        if (event.running) {
          sawActive = true
        } else if (sawActive || sendReturned) {
          // Wait briefly for state:changed if a queued message is about to dispatch.
          if (!isThreadBusy(latestState, thread.id)) settle()
        }
      }
    },
    onState: (nextState) => {
      latestState = nextState
      if (isThreadBusy(nextState, thread.id)) {
        sawActive = true
      } else if ((sawActive || sendReturned) && !isThreadBusy(nextState, thread.id)) {
        settle()
      }
    },
    onDisconnect: (err) => {
      settle(new CliError(`Disconnected from Agent Desktop before turn completed${err ? `: ${err.message}` : ''}`, EXIT_ERROR))
    }
  })

  let sigintCount = 0
  const onSigint = () => {
    sigintCount++
    interrupted = true
    if (sigintCount === 1) {
      io.stderr.write('\n[interrupt] Stopping run...\n')
      void runtime.call('agent:stop', thread.id).catch(() => settle())
    } else {
      settle()
    }
  }
  process.on('SIGINT', onSigint)

  try {
    await runtime.call('agent:send', req)
    sendReturned = true

    // If the turn completed synchronously/very quickly before we reached here, verify current state.
    if (!settled) {
      const postState = await runtime.call<AppState>('state:get')
      latestState = postState
      if (!isThreadBusy(postState, thread.id)) {
        const finalItems = await runtime.call<Item[]>('thread:items', thread.id)
        renderer.onItems(finalItems)
        settle()
      }
    }

    await donePromise
    const finalItems = await runtime.call<Item[]>('thread:items', thread.id).catch(() => renderer.items)
    renderer.onItems(finalItems)
  } finally {
    process.off('SIGINT', onSigint)
    unsubscribe()
  }

  if (questionExitItem) {
    const payload = {
      ok: false,
      reason: 'question_required',
      threadId: thread.id,
      questionId: questionExitItem.id,
      title: questionExitItem.title,
      questions: questionExitItem.questions
    }
    if (opts.format === 'json' || opts.format === 'jsonl') {
      writeJson(io, payload)
    } else {
      io.stderr.write(
        `\n[question] Agent asked a question (questionId=${questionExitItem.id}). ` +
        `Answer via: agent-desktop answer ${thread.id} ${questionExitItem.id} --answers '[...]'\n`
      )
    }
    return EXIT_QUESTION_REQUIRED
  }

  if (opts.format === 'json') {
    const res = renderer.result
    writeJson(io, {
      ok: !interrupted && !(res?.isError ?? false),
      interrupted,
      threadId: thread.id,
      projectId: thread.projectId,
      cli: provider,
      mode,
      model,
      runtimeMode: runtime.mode,
      text: renderer.assistantText,
      durationMs: res?.durationMs,
      fileChanges: res?.fileChanges?.map((f) => f.path) ?? [],
      usage: res?.usage,
      isError: res?.isError ?? false
    })
  } else {
    renderer.finishTextSummary()
  }

  if (interrupted) return EXIT_SIGINT
  return renderer.result?.isError ? EXIT_ERROR : EXIT_OK
}

export async function runWatchCommand(
  runtime: CliRuntime,
  io: CliIo,
  positionals: string[],
  opts: { format: OutputFormat; quiet?: boolean; showThinking?: boolean }
): Promise<number> {
  const threadId = positionals[0]
  if (!threadId) throw new CliError('Usage: agent-desktop watch <threadId>', EXIT_USAGE)
  if (runtime.mode !== 'attached') {
    throw new CliError('watch requires a running Agent Desktop instance.', EXIT_USAGE)
  }

  const state = await runtime.call<AppState>('state:get')
  const thread = state.threads.find((t) => t.id === threadId)
  if (!thread) throw new CliError(`Thread not found: ${threadId}`, EXIT_USAGE)

  const initialItems = await runtime.call<Item[]>('thread:items', threadId)
  const renderer = new StreamRenderer({
    format: opts.format,
    quiet: opts.quiet,
    showThinking: opts.showThinking,
    io
  })
  renderer.onItems(initialItems)

  if (!isThreadBusy(state, threadId)) {
    renderer.finishTextSummary()
    return renderer.result?.isError ? EXIT_ERROR : EXIT_OK
  }

  let resolveDone!: () => void
  let rejectDone!: (err: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  let detachedByUser = false
  const unsubscribe = await runtime.subscribe({
    onEvent: (event) => {
      if (event.threadId !== threadId) return
      if (event.type === 'items') renderer.onItems(event.items)
      else if (event.type === 'running' && !event.running) resolveDone()
    },
    onState: (next) => {
      if (!isThreadBusy(next, threadId)) resolveDone()
    },
    onDisconnect: (err) => rejectDone(new CliError(`Disconnected${err ? `: ${err.message}` : ''}`, EXIT_ERROR))
  })

  const onSigint = () => {
    detachedByUser = true
    io.stderr.write(`\n[watch] Detached. Thread ${threadId} continues running (stop via "agent-desktop stop ${threadId}").\n`)
    resolveDone()
  }
  process.on('SIGINT', onSigint)

  try {
    await done
  } finally {
    process.off('SIGINT', onSigint)
    unsubscribe()
  }

  if (detachedByUser) return EXIT_SIGINT
  renderer.finishTextSummary()
  return renderer.result?.isError ? EXIT_ERROR : EXIT_OK
}

export async function runStopCommand(
  runtime: CliRuntime,
  io: CliIo,
  positionals: string[],
  opts: { format: OutputFormat }
): Promise<number> {
  const threadId = positionals[0]
  if (!threadId) throw new CliError('Usage: agent-desktop stop <threadId>', EXIT_USAGE)
  await runtime.call('agent:stop', threadId)
  if (opts.format === 'json' || opts.format === 'jsonl') {
    writeJson(io, { stopped: true, threadId })
  } else {
    io.stdout.write(`Stopped thread ${threadId}.\n`)
  }
  return EXIT_OK
}

export async function runAnswerCommand(
  runtime: CliRuntime,
  io: CliIo,
  positionals: string[],
  opts: { format: OutputFormat; answersJson?: string; skip?: boolean }
): Promise<number> {
  const [threadId, questionId] = positionals
  if (!threadId || !questionId) {
    throw new CliError('Usage: agent-desktop answer <threadId> <questionId> (--answers <json> | --skip)', EXIT_USAGE)
  }

  let answers: QuestionAnswer[] | null
  if (opts.skip) {
    answers = null
  } else if (opts.answersJson) {
    try {
      const parsed = JSON.parse(opts.answersJson)
      if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of QuestionAnswer objects')
      answers = parsed as QuestionAnswer[]
    } catch (err) {
      throw new CliError(`Invalid --answers JSON: ${err instanceof Error ? err.message : String(err)}`, EXIT_USAGE)
    }
  } else {
    throw new CliError('Provide --answers <json> or --skip.', EXIT_USAGE)
  }

  await runtime.call('agent:answerQuestion', threadId, questionId, answers)
  if (opts.format === 'json' || opts.format === 'jsonl') {
    writeJson(io, { answered: true, threadId, questionId, skipped: answers === null })
  } else {
    io.stdout.write(`${answers === null ? 'Skipped' : 'Answered'} question ${questionId} on thread ${threadId}.\n`)
  }
  return EXIT_OK
}
