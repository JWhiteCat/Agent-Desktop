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
import { isPromptAbortError, promptQuestionInteractively } from '../prompt-ui'
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

function isThreadActive(state: AppState, threadId: string): boolean {
  return state.running.includes(threadId) || (state.starting ?? []).includes(threadId)
}

function hasRunnableQueue(state: AppState, threadId: string): boolean {
  const q = state.queued?.[threadId]
  if (!q || q.items.length === 0) return false
  return !!q.items[0]?.immediate || (!q.paused && !q.waitingForPlan)
}

function isThreadBusy(state: AppState, threadId: string): boolean {
  return isThreadActive(state, threadId) || hasRunnableQueue(state, threadId)
}

function hasNewUserItem(items: Item[], seenIds: Set<string>, expectedPrompt?: string): boolean {
  return items.some(
    (item) =>
      item.kind === 'user' &&
      !seenIds.has(item.id) &&
      (expectedPrompt === undefined || item.text === expectedPrompt)
  )
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
    if (opts.format === 'json' || opts.format === 'jsonl') writeJson(io, info, opts.format)
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

  const preTurnItemIds = new Set<string>(baselineItems.map((i) => i.id))
  const initialQueueIds = new Set<string>((state.queued?.[thread.id]?.items ?? []).map((q) => q.id))
  let latestState: AppState = state
  let sendStarted = false
  let sendReturned = false
  let sawActive = false
  let sawOwnUserItem = false
  let wasBusyBeforeSend = isThreadBusy(state, thread.id)
  let trackedQueueId: string | undefined
  let queuePhase: 'none' | 'queued' | 'dispatching' | 'running' = 'none'
  let handlingQuestion = false
  const questionAbort = new AbortController()

  let sigintCount = 0
  const triggerInterrupt = (): void => {
    sigintCount++
    interrupted = true
    questionAbort.abort()
    if (sigintCount === 1) {
      io.stderr.write('\n[interrupt] Stopping run...\n')
      void runtime.call('agent:stop', thread.id).then(
        () => {
          if (!isThreadActive(latestState, thread.id)) settle()
        },
        () => settle()
      )
    } else {
      settle()
    }
  }

  const recordPreTurnItems = (items: Item[]): void => {
    for (const item of items) preTurnItemIds.add(item.id)
  }

  const filterTurnItems = (items: Item[]): Item[] => items.filter((item) => !preTurnItemIds.has(item.id))

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
          const answers = await promptQuestionInteractively(qItem, io, questionAbort.signal)
          if (interrupted || settled) {
            handlingQuestion = false
            return
          }
          await runtime.call('agent:answerQuestion', thread.id, qItem.id, answers)
          handlingQuestion = false
        } catch (err) {
          handlingQuestion = false
          if (settled) return
          if (interrupted || isPromptAbortError(err)) {
            if (!interrupted) triggerInterrupt()
            return
          }
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

  const handleState = (nextState: AppState): void => {
    latestState = nextState
    const active = isThreadActive(nextState, thread.id)
    const queue = nextState.queued?.[thread.id]
    const queueItems = queue?.items ?? []

    if (interrupted) {
      if (!active) settle()
      return
    }

    if (!sendStarted) {
      for (const q of queueItems) initialQueueIds.add(q.id)
      wasBusyBeforeSend = isThreadBusy(nextState, thread.id)
      return
    }

    if (delivery && queuePhase === 'none' && !trackedQueueId && queueItems.length > 0) {
      const added = queueItems.filter((q) => !initialQueueIds.has(q.id))
      const match =
        added.find((q) => q.prompt === prompt) ??
        (delivery === 'now' ? added[0] : added[added.length - 1])
      if (match) {
        trackedQueueId = match.id
        queuePhase = 'queued'
      }
    }

    if (queuePhase === 'queued' && trackedQueueId) {
      const stillQueued = queueItems.some((q) => q.id === trackedQueueId)
      if (stillQueued) {
        if (queue?.error && queue.paused && !active) {
          settle(new CliError(queue.error, EXIT_ERROR))
          return
        }
        if (!isThreadBusy(nextState, thread.id)) {
          settle()
        }
        return
      }
      if (active) {
        queuePhase = 'running'
        sawActive = true
      } else {
        queuePhase = 'dispatching'
      }
      return
    }

    if (queuePhase === 'dispatching') {
      if (active) {
        queuePhase = 'running'
        sawActive = true
        return
      }
      if (trackedQueueId && queueItems.some((q) => q.id === trackedQueueId)) {
        if (queue?.error && queue.paused) {
          settle(new CliError(queue.error, EXIT_ERROR))
          return
        }
        queuePhase = 'queued'
        if (!isThreadBusy(nextState, thread.id)) settle()
        return
      }
      if (!nextState.threads.some((t) => t.id === thread.id)) {
        settle(new CliError(`Thread not found: ${thread.id}`, EXIT_ERROR))
      }
      return
    }

    if (queuePhase === 'running') {
      if (active) {
        sawActive = true
      } else if (sendReturned && (sawActive || sawOwnUserItem)) {
        settle()
      }
      return
    }

    if (isThreadBusy(nextState, thread.id)) {
      if (!wasBusyBeforeSend || !delivery) sawActive = true
    } else if (sendReturned) {
      if (wasBusyBeforeSend && delivery && !sawActive && !sawOwnUserItem) {
        queuePhase = 'dispatching'
        return
      }
      settle()
    }
  }

  const unsubscribe = await runtime.subscribe({
    onEvent: (event) => {
      if (event.threadId !== thread.id) return
      if (event.type === 'items') {
        const buffering =
          !sendStarted ||
          queuePhase === 'queued' ||
          queuePhase === 'dispatching' ||
          (!sendReturned && wasBusyBeforeSend && !!delivery)
        if (buffering) {
          const ownStarted =
            (queuePhase === 'dispatching' && hasNewUserItem(event.items, preTurnItemIds)) ||
            (sendStarted && !sendReturned && wasBusyBeforeSend && !!delivery && hasNewUserItem(event.items, preTurnItemIds, prompt))
          if (ownStarted) {
            queuePhase = 'running'
            sawOwnUserItem = true
            renderer.onItems(filterTurnItems(event.items))
          } else {
            recordPreTurnItems(event.items)
          }
          return
        }
        renderer.onItems(filterTurnItems(event.items))
      } else if (event.type === 'running') {
        if (event.running) {
          if (queuePhase === 'dispatching') {
            queuePhase = 'running'
            sawActive = true
          } else if (sendStarted && queuePhase !== 'queued') {
            sawActive = true
          }
        } else {
          if (interrupted) {
            settle()
            return
          }
          if (queuePhase === 'queued' || queuePhase === 'dispatching') {
            return
          }
          if (queuePhase === 'running') {
            if (sendReturned && (sawActive || sawOwnUserItem)) settle()
            return
          }
          if (sendReturned && (sawActive || !wasBusyBeforeSend || !delivery) && !hasRunnableQueue(latestState, thread.id)) {
            settle()
          }
        }
      }
    },
    onState: (nextState) => {
      handleState(nextState)
    },
    onDisconnect: (err) => {
      settle(new CliError(`Disconnected from Agent Desktop before turn completed${err ? `: ${err.message}` : ''}`, EXIT_ERROR))
    }
  })

  process.on('SIGINT', triggerInterrupt)

  try {
    sendStarted = true
    await runtime.call('agent:send', req)
    sendReturned = true

    // If the turn completed synchronously/very quickly before we reached here, verify current state.
    if (!settled) {
      const postState = await runtime.call<AppState>('state:get')
      if (!isThreadBusy(postState, thread.id) && queuePhase === 'none' && wasBusyBeforeSend && delivery && !sawActive && !sawOwnUserItem) {
        const postItems = await runtime.call<Item[]>('thread:items', thread.id).catch(() => renderer.items)
        if (hasNewUserItem(postItems, preTurnItemIds, prompt)) {
          sawOwnUserItem = true
          renderer.onItems(filterTurnItems(postItems))
        }
      }
      handleState(postState)
    }

    await donePromise
    if (queuePhase === 'none' || queuePhase === 'running') {
      const finalItems = await runtime.call<Item[]>('thread:items', thread.id).catch(() => renderer.items)
      renderer.onItems(filterTurnItems(finalItems))
    }
  } finally {
    questionAbort.abort()
    process.off('SIGINT', triggerInterrupt)
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
      writeJson(io, payload, opts.format)
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

  const seenUserIds = new Set(initialItems.filter((i) => i.kind === 'user').map((i) => i.id))
  let latestState: AppState = state
  let runnableHeadId: string | undefined = hasRunnableQueue(state, threadId)
    ? state.queued?.[threadId]?.items[0]?.id
    : undefined
  let awaitingQueuedDispatch = false
  let settled = false
  let detachedByUser = false

  let resolveDone!: () => void
  let rejectDone!: (err: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const settle = (err?: Error): void => {
    if (settled) return
    settled = true
    if (err) rejectDone(err)
    else resolveDone()
  }

  const handleState = (next: AppState): void => {
    latestState = next
    const active = isThreadActive(next, threadId)
    const runnable = hasRunnableQueue(next, threadId)
    const nextHeadId = runnable ? next.queued?.[threadId]?.items[0]?.id : undefined
    const queueItems = next.queued?.[threadId]?.items ?? []

    if (awaitingQueuedDispatch) {
      if (active || runnable) {
        awaitingQueuedDispatch = false
        runnableHeadId = nextHeadId
        return
      }
      if (queueItems.length > 0 || !next.threads.some((t) => t.id === threadId)) {
        awaitingQueuedDispatch = false
        runnableHeadId = undefined
        settle()
      }
      return
    }

    if (runnableHeadId && !active && !queueItems.some((q) => q.id === runnableHeadId)) {
      runnableHeadId = undefined
      awaitingQueuedDispatch = true
      return
    }

    runnableHeadId = nextHeadId
    if (!isThreadBusy(next, threadId)) {
      settle()
    }
  }

  const unsubscribe = await runtime.subscribe({
    onEvent: (event) => {
      if (event.threadId !== threadId) return
      if (event.type === 'items') {
        if (awaitingQueuedDispatch && hasNewUserItem(event.items, seenUserIds)) {
          awaitingQueuedDispatch = false
        }
        for (const item of event.items) {
          if (item.kind === 'user') seenUserIds.add(item.id)
        }
        renderer.onItems(event.items)
      } else if (event.type === 'running') {
        if (event.running) {
          awaitingQueuedDispatch = false
        } else if (!awaitingQueuedDispatch && !hasRunnableQueue(latestState, threadId)) {
          settle()
        }
      }
    },
    onState: (next) => {
      handleState(next)
    },
    onDisconnect: (err) => settle(new CliError(`Disconnected${err ? `: ${err.message}` : ''}`, EXIT_ERROR))
  })

  const onSigint = () => {
    detachedByUser = true
    io.stderr.write(`\n[watch] Detached. Thread ${threadId} continues running (stop via "agent-desktop stop ${threadId}").\n`)
    settle()
  }
  process.on('SIGINT', onSigint)

  try {
    if (!settled) {
      const postState = await runtime.call<AppState>('state:get')
      const postItems = await runtime.call<Item[]>('thread:items', threadId).catch(() => renderer.items)
      if (hasNewUserItem(postItems, seenUserIds)) {
        runnableHeadId = undefined
        awaitingQueuedDispatch = false
      }
      for (const item of postItems) {
        if (item.kind === 'user') seenUserIds.add(item.id)
      }
      renderer.onItems(postItems)
      if (!settled) handleState(postState)
    }

    await done
    if (!detachedByUser) {
      const finalItems = await runtime.call<Item[]>('thread:items', threadId).catch(() => renderer.items)
      renderer.onItems(finalItems)
    }
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
    writeJson(io, { stopped: true, threadId }, opts.format)
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
    writeJson(io, { answered: true, threadId, questionId, skipped: answers === null }, opts.format)
  } else {
    io.stdout.write(`${answers === null ? 'Skipped' : 'Answered'} question ${questionId} on thread ${threadId}.\n`)
  }
  return EXIT_OK
}
