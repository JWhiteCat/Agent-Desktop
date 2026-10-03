import type { ChildProcess } from 'node:child_process'
import type { CliProvider, SendRequest } from '@shared/types'
import { claudePlanModePrompt, codexPlanModePrompt, planModePrompt, type AcpConnection } from '../acp'
import { resolveApiKey, resolveCli, spawnCli, type ResolvedCli } from '../cli'
import {
  claudeAsCli, claudeModeId, CLAUDE_EFFORT_CONFIG_ID, CLAUDE_MODEL_CONFIG_ID,
  parseClaudeModelId, resolveClaude, resolveClaudeApiKey, spawnClaudeAcp, type ResolvedClaude
} from '../claude'
import { codexAsCli, codexModeId, resolveCodex, resolveCodexApiKey, spawnCodexAcp, type ResolvedCodex } from '../codex'

/** Provider operations only need the ACP request channel and the current session identity. */
export interface SessionConnection {
  acp: Pick<AcpConnection, 'request'>
  sessionId: string
  provider: CliProvider
}

export interface AgentLaunch {
  cli: ResolvedCli
  codex?: ResolvedCodex
  claude?: ResolvedClaude
}

type Sandbox = 'default' | 'enabled' | 'disabled'

export function resolveLaunch(provider: CliProvider, agentPath: string, codexPath: string, claudePath: string): AgentLaunch | undefined {
  if (provider === 'codex') {
    const codex = resolveCodex(codexPath)
    return codex ? { cli: codexAsCli(codex), codex } : undefined
  }
  if (provider === 'claude') {
    const claude = resolveClaude(claudePath)
    return claude ? { cli: claudeAsCli(claude), claude } : undefined
  }
  const cli = resolveCli(agentPath)
  return cli ? { cli } : undefined
}

export function providerApiKey(provider: CliProvider, settings: { apiKey: string; codexApiKey: string; claudeApiKey: string }): string {
  if (provider === 'codex') return resolveCodexApiKey(settings.codexApiKey)
  if (provider === 'claude') return resolveClaudeApiKey(settings.claudeApiKey)
  return resolveApiKey(settings.apiKey)
}

export function cursorArgs(req: SendRequest, sandbox: Sandbox, cwd: string, hasChat: boolean): string[] {
  const args = ['--trust']
  if (req.model && req.model !== 'auto') args.push('--model', req.model)
  if (req.mode !== 'agent') args.push('--mode', req.mode)
  if (req.force) args.push('--force')
  if (sandbox !== 'default') args.push('--sandbox', sandbox)
  if (!hasChat && req.worktree) args.push('--worktree')
  args.push('--workspace', cwd, 'acp')
  return args
}

export function cliLabel(provider: CliProvider): string {
  if (provider === 'codex') return 'Codex CLI'
  if (provider === 'claude') return 'Claude Code'
  return 'Cursor CLI'
}

export function procFingerprint(
  cli: ResolvedCli,
  provider: CliProvider,
  cwd: string,
  sandbox: string,
  force: boolean,
  apiKey: string,
  mcpServers: unknown,
  skills: unknown
): string {
  return JSON.stringify([provider, cli.command, cli.prefixArgs, cwd, sandbox, force ? 1 : 0, apiKey, mcpServers, skills])
}

/** Same fingerprint with another working directory, for a process whose session moved into a worktree. */
export function fingerprintWithCwd(fingerprint: string, cwd: string): string {
  if (!fingerprint) return fingerprint
  const parts = JSON.parse(fingerprint)
  parts[3] = cwd
  return JSON.stringify(parts)
}

/**
 * `agent --worktree acp` prints the worktree path on stdout before any JSON-RPC output.
 * `session/new` must use that path; the project path would make the agent edit the project itself.
 */
export function worktreePathFrom(line: string): string | undefined {
  const match = /^Using worktree:\s*(.+)$/.exec(line.trim())
  return match?.[1].trim() || undefined
}

export function spawnProvider(provider: CliProvider, launch: AgentLaunch, args: string[], cwd: string, apiKey: string): ChildProcess {
  return provider === 'codex' && launch.codex
    ? spawnCodexAcp(launch.codex, cwd, apiKey)
    : provider === 'claude' && launch.claude
      ? spawnClaudeAcp(launch.claude, cwd, apiKey)
      : spawnCli(launch.cli, args, cwd, 'pipe', apiKey)
}

export async function initializeSession(acp: SessionConnection['acp'], provider: CliProvider, apiKey: string): Promise<any> {
  const initialized = await acp.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      ...(provider === 'codex' ? { plan: {} } : {})
    },
    clientInfo: { name: 'agent-desktop', version: '0.1.0' }
  })
  // Cursor API key auth is `--api-key` at process start. `cursor_login` clears stored
  // API-key credentials, so it only runs when no key is configured.
  if (provider === 'cursor' && !apiKey) await acp.request('authenticate', { methodId: 'cursor_login' })
  if (provider === 'codex' && apiKey) await acp.request('authenticate', { methodId: 'api-key' })
  if (provider === 'codex' && !apiKey) await acp.request('authenticate', { methodId: 'chat-gpt' })
  // Claude uses ANTHROPIC_API_KEY at process start, or the login already stored in ~/.claude.
  return initialized
}

export async function applySessionOptions(session: SessionConnection, req: SendRequest, sandbox: Sandbox): Promise<void> {
  if (session.provider === 'codex') {
    await applyCodexOptions(session, req, sandbox)
    return
  }
  if (session.provider === 'claude') {
    await applyClaudeOptions(session, req)
    return
  }
  const { acp, sessionId } = session
  try {
    await acp.request('session/set_mode', { sessionId, modeId: req.mode })
  } catch {
    /* --mode on the process is the fallback */
  }
  if (req.model) {
    try {
      await acp.request('session/set_model', { sessionId, modelId: req.model })
    } catch {
      /* --model on the process is the fallback when it is not "auto" */
    }
  }
}

async function applyCodexOptions(session: SessionConnection, req: SendRequest, sandbox: Sandbox): Promise<void> {
  const { acp, sessionId } = session
  const modeId = codexModeId(req.mode, req.force, sandbox)
  try {
    await acp.request('session/set_config_option', {
      sessionId,
      configId: 'collaboration_mode',
      value: req.mode === 'plan' ? 'plan' : 'default'
    })
  } catch (error) {
    // Do not start a planning prompt with Agent permissions unless the adapter
    // has enabled Plan. Older adapters may still run ordinary Agent/Ask turns.
    if (req.mode === 'plan') throw error
  }
  // A failed permission change must not silently run with the previous preset.
  await acp.request('session/set_mode', { sessionId, modeId })
  await applyCodexModel(session, req.model)
}

async function applyClaudeOptions(session: SessionConnection, req: SendRequest): Promise<void> {
  try {
    await session.acp.request('session/set_mode', { sessionId: session.sessionId, modeId: claudeModeId(req.mode, req.force) })
  } catch {
    /* the next prompt still runs in whatever mode the process started with */
  }
  await applyClaudeModel(session, req.model)
}

async function applyClaudeModel(session: SessionConnection, model: string): Promise<void> {
  if (!model || model === 'auto') return
  const { model: id, effort } = parseClaudeModelId(model)
  try {
    await session.acp.request('session/set_config_option', { sessionId: session.sessionId, configId: CLAUDE_MODEL_CONFIG_ID, value: id })
  } catch {
    /* keep the session's current model */
  }
  if (!effort) return
  try {
    await session.acp.request('session/set_config_option', { sessionId: session.sessionId, configId: CLAUDE_EFFORT_CONFIG_ID, value: effort })
  } catch {
    /* the model keeps its default effort */
  }
}

async function applyCodexModel(session: SessionConnection, model: string): Promise<void> {
  if (!model || model === 'auto') return
  const bracket = model.match(/^([^[]+)\[([^\]]+)\]$/)
  const id = bracket?.[1] ?? model
  try {
    await session.acp.request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: id })
  } catch {
    /* keep the session's current model */
  }
  if (!bracket?.[2]) return
  try {
    await session.acp.request('session/set_config_option', {
      sessionId: session.sessionId,
      configId: 'reasoning_effort',
      value: bracket[2]
    })
  } catch {
    /* the model keeps its default effort */
  }
}

export function planPrompt(provider: CliProvider, mode: SendRequest['mode'], prompt: string): string {
  if (mode !== 'plan') return prompt
  if (provider === 'codex') return codexPlanModePrompt(prompt)
  if (provider === 'claude') return claudePlanModePrompt(prompt)
  return planModePrompt(prompt)
}

/**
 * The CLI approves SwitchMode on its own in ACP and sends no mode update, so a plan turn
 * would silently turn into an editing turn. Seeing the switch finish is the only signal.
 */
export function leftPlanMode(update: any, switchCalls: Set<string>): boolean {
  if (update?.sessionUpdate === 'current_mode_update') return update.currentModeId !== 'plan'
  if (update?.sessionUpdate !== 'tool_call' && update?.sessionUpdate !== 'tool_call_update') return false
  const id = String(update.toolCallId ?? '')
  if (update.kind === 'switch_mode') switchCalls.add(id)
  if (update.status !== 'completed' || !switchCalls.has(id)) return false
  switchCalls.delete(id)
  return true
}
