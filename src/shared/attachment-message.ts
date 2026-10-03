const OPEN = '<agent_desktop_attachments>'
const CLOSE = '</agent_desktop_attachments>'
const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Only wrappers injected by the clients may precede an internal message marker.
const CONTEXT_PREFIX = /^<(agent_desktop_client|environment_details|environment_context|user_info|additional_instructions|system_reminder)\b[^>]*>[\s\S]*?<\/\1>\s*/

export function isManagedMessageId(value: unknown): value is string {
  return typeof value === 'string' && MESSAGE_ID.test(value)
}

/** Identifies an attachment turn; file metadata is deliberately kept out of CLI text. */
export function attachmentPrompt(prompt: string, managedMessageId: string): string {
  if (!isManagedMessageId(managedMessageId)) throw new Error('Invalid attachment message ID')
  return `${OPEN}${JSON.stringify({ version: 1, messageId: managedMessageId })}${CLOSE}\n\n${prompt}`
}

/** Recognizes a leading marker, optionally inside known CLI-injected prompt wrappers. */
export function parseAttachmentPrompt(raw: string): { prompt: string; managedMessageId?: string } {
  let body = raw.trimStart()
  let inQuery = false
  for (;;) {
    const context = body.match(CONTEXT_PREFIX)
    if (context) {
      body = body.slice(context[0].length)
      continue
    }
    if (!inQuery && body.startsWith('<user_query>')) {
      inQuery = true
      body = body.slice('<user_query>'.length).trimStart()
      continue
    }
    break
  }
  if (!body.startsWith(OPEN)) return { prompt: raw }
  const end = body.indexOf(CLOSE, OPEN.length)
  if (end < 0) return { prompt: raw }
  let marker: unknown
  try {
    marker = JSON.parse(body.slice(OPEN.length, end))
  } catch {
    return { prompt: raw }
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return { prompt: raw }
  const fields = marker as Record<string, unknown>
  if (fields.version !== 1 || !isManagedMessageId(fields.messageId)
    || Object.keys(fields).some((key) => key !== 'version' && key !== 'messageId')) return { prompt: raw }
  let prompt = body.slice(end + CLOSE.length)
  if (inQuery) {
    const close = prompt.lastIndexOf('</user_query>')
    if (close < 0 || prompt.slice(close + '</user_query>'.length).trim()) return { prompt: raw }
    prompt = prompt.slice(0, close)
  }
  return { prompt: prompt.trim(), managedMessageId: fields.messageId }
}
