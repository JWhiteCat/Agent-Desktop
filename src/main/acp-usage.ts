import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Cursor CLI's ACP presenter handles text, thoughts, and tool calls, then drops
 * `turnEnded` (the only update that carries token counts). This anchor is the
 * last case in `presentInteractionUpdate` as of CLI 2026.09.23.
 */
export const ACP_TURN_USAGE_ANCHOR =
  'case"thinkingDelta":yield this.sendSessionUpdate({sessionUpdate:"agent_thought_chunk",content:{type:"text",text:e.message.value.text}})'

const TURN_ENDED_CASE =
  'case"turnEnded":{const __ad=e.message.value||{};const __n=v=>{if(typeof v==="bigint")return Number(v);const n=Number(v&&typeof v==="object"&&typeof v.toString==="function"?v.toString():v||0);return Number.isFinite(n)?n:0};const __u={inputTokens:__n(__ad.inputTokens),outputTokens:__n(__ad.outputTokens),cacheReadTokens:__n(__ad.cacheReadTokens),cacheWriteTokens:__n(__ad.cacheWriteTokens)};if(__u.inputTokens||__u.outputTokens||__u.cacheReadTokens||__u.cacheWriteTokens)yield this.sendSessionUpdate({sessionUpdate:"usage_update",usage:Object.assign({inputIncludesCache:true},__u)});break}'

export function patchAcpPresenterSource(source: string): string {
  if (!source.includes(ACP_TURN_USAGE_ANCHOR) || source.includes('case"turnEnded":')) return source
  return source.replace(ACP_TURN_USAGE_ANCHOR, TURN_ENDED_CASE + ACP_TURN_USAGE_ANCHOR)
}

export function acpUsagePreloadSource(): string {
  return `'use strict';
const Module = require('module');
const orig = Module.prototype._compile;
const anchor = ${JSON.stringify(ACP_TURN_USAGE_ANCHOR)};
const turnEnded = ${JSON.stringify(TURN_ENDED_CASE)};
Module.prototype._compile = function (content, filename) {
  if (typeof content === 'string' && typeof filename === 'string' && filename.endsWith('6589.index.js') && content.includes(anchor) && !content.includes('case"turnEnded":')) {
    content = content.replace(anchor, turnEnded + anchor);
  }
  return orig.call(this, content, filename);
};
`
}

const PRELOAD_NAME = 'agent-desktop-acp-usage.cjs'

/** Point the CLI's node at a preload that rewrites the ACP presenter as it loads. */
export function installAcpUsagePreload(env: NodeJS.ProcessEnv): void {
  const file = path.join(os.tmpdir(), PRELOAD_NAME)
  const source = acpUsagePreloadSource()
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== source) fs.writeFileSync(file, source)
  } catch {
    return
  }
  const requireArg = quoteNodeOption(file.replace(/\\/g, '/'))
  if (env.NODE_OPTIONS?.includes(requireArg)) return
  const flag = `--require ${requireArg}`
  const prev = env.NODE_OPTIONS?.trim() ?? ''
  env.NODE_OPTIONS = prev ? `${prev} ${flag}` : flag
}

function quoteNodeOption(value: string): string {
  if (!/[\s"]/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}
