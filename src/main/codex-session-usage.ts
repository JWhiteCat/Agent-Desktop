import { net } from 'electron'
import { parseCodexSessionUsage, type CodexSessionUsage } from '@shared/codex-account'
import { resolveCodexApiKey } from './codex'
import { readCodexAuth } from './quota'

const CODEX_TASK_USAGE = 'https://chatgpt.com/backend-api/wham/usage/thread_usage/query_v2'
const FETCH_MS = 8_000

/** Consumer allowance usage for this task, including its descendant threads. */
export async function loadCodexSessionUsage(
  threadId: string,
  createdAt?: number,
  descendantThreadIds: string[] = []
): Promise<CodexSessionUsage | undefined> {
  try {
    if (!validThreadId(threadId) || resolveCodexApiKey(undefined)) return undefined
    const auth = readCodexAuth()
    if (auth.kind !== 'token') return undefined
    const descendants = [...new Set(descendantThreadIds)].filter((id) => validThreadId(id) && id !== threadId)
    // Query v2 permits 1,000 distinct IDs, including the task root. Do not silently omit children.
    if (descendants.length > 999) return undefined
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json'
    }
    if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId
    // Chromium follows the system proxy used by account quota requests.
    const response = await net.fetch(CODEX_TASK_USAGE, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        threads: [{ thread_id: threadId, created_at: createdAtIso(createdAt), descendant_thread_ids: descendants }]
      }),
      signal: AbortSignal.timeout(FETCH_MS)
    })
    if (!response.ok) return undefined
    return parseCodexSessionUsage(await response.json(), threadId)
  } catch {
    return undefined
  }
}

function validThreadId(id: string): boolean {
  return typeof id === 'string' && Boolean(id.trim()) && Buffer.byteLength(id, 'utf8') <= 512
}

function createdAtIso(timestamp: number | undefined): string | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
