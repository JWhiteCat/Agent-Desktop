import { parseCodexThreadUsage, type CodexSessionUsage, type CodexThreadUsage } from '@shared/codex-account'
import { parseCodexQuota, type ProviderQuota } from '@shared/quota'
import { AcpConnection, MethodNotFound } from './acp'
import { killTree } from './cli'
import { resolveCodex, spawnCodexAppServer } from './codex'
import { loadCodexSessionUsage } from './codex-session-usage'
import { readCodexSessionCreatedAt } from './codex-history'

const READ_TIMEOUT_MS = 8_000

export interface CodexAccountUsage {
  sessionUsage?: CodexSessionUsage
  threadUsage?: CodexThreadUsage
  quota?: ProviderQuota
  /** When the quota RPC returned, independent of a slower thread-usage request. */
  quotaSampledAt?: number
}

/** Read existing account records without loading, resuming, or prompting a thread. */
export async function loadCodexAccountUsage(customPath: string, threadId: string): Promise<CodexAccountUsage> {
  if (!threadId) return {}
  const [account, session] = await Promise.allSettled([
    loadCodexRpcAccountUsage(customPath, threadId),
    loadCodexSessionUsage(threadId, readCodexSessionCreatedAt(threadId))
  ])
  return {
    ...(account.status === 'fulfilled' ? account.value : {}),
    ...(session.status === 'fulfilled' && session.value ? { sessionUsage: session.value } : {})
  }
}

async function loadCodexRpcAccountUsage(customPath: string, threadId: string): Promise<CodexAccountUsage> {
  if (!threadId) return {}
  const codex = resolveCodex(customPath)
  if (!codex) return {}
  let child: ReturnType<typeof spawnCodexAppServer>
  try {
    child = spawnCodexAppServer(codex)
  } catch {
    return {}
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let fail!: (error: Error) => void
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject
    timer = setTimeout(() => reject(new Error('Codex usage request timed out')), READ_TIMEOUT_MS)
  })
  child.on('error', fail)
  child.stdin?.on('error', fail)
  child.once('close', () => {
    child.removeListener('error', fail)
    child.stdin?.removeListener('error', fail)
  })
  child.stderr?.resume()
  const rpc = new AcpConnection(child)
  rpc.start({
    onRequest: async (method) => { throw new MethodNotFound(method) },
    onNotification: () => undefined
  })
  const request = (method: string, params: unknown) => Promise.race([rpc.request(method, params), failed])
  try {
    await request('initialize', {
      clientInfo: { name: 'agent-desktop-usage', title: 'Agent Desktop', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    })
    rpc.notify('initialized', {})
    const [quotaResult, usageResult] = await Promise.allSettled([
      request('account/rateLimits/read', {}).then((body) => ({ body, sampledAt: Date.now() })),
      request('account/usage/read', { threadId })
    ])
    const result: CodexAccountUsage = {}
    if (quotaResult.status === 'fulfilled') {
      const quota = parseCodexQuota(quotaResult.value.body)
      if (quota.windows.length) {
        result.quota = quota
        result.quotaSampledAt = quotaResult.value.sampledAt
      }
    }
    if (usageResult.status === 'fulfilled') {
      const usage = parseCodexThreadUsage(usageResult.value, threadId)
      if (usage) result.threadUsage = usage
    }
    return result
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
    // Error handlers stay installed until process close, including late pipe errors.
    killTree(child)
  }
}
