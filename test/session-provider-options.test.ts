import { describe, expect, it, vi } from 'vitest'
import type { SendRequest } from '../src/shared/types'
import { applySessionOptions, type SessionConnection } from '../src/main/session/provider'

const SESSION_ID = 'codex-options-session'

function setup(mode: SendRequest['mode'] = 'plan', force = true) {
  const request = vi.fn(async (_method: string, _params: unknown) => ({}))
  const session: SessionConnection = { provider: 'codex', sessionId: SESSION_ID, acp: { request } }
  const req: SendRequest = { threadId: 'thread', prompt: 'Inspect the project', model: 'auto', mode, force }
  return { request, session, req }
}

describe('Codex session permission configuration', () => {
  it('waits for Plan collaboration mode before enabling the selected implementation permissions', async () => {
    const ctx = setup()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    ctx.request.mockImplementationOnce(async () => {
      await pending
      return {}
    })

    const configured = applySessionOptions(ctx.session, ctx.req, 'default')
    await Promise.resolve()
    expect(ctx.request.mock.calls).toEqual([
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'collaboration_mode', value: 'plan' }]
    ])

    release()
    await configured
    expect(ctx.request.mock.calls).toEqual([
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'collaboration_mode', value: 'plan' }],
      ['session/set_mode', { sessionId: SESSION_ID, modeId: 'agent-full-access' }]
    ])
  })

  it.each([false, true])('stops before changing permissions when Plan configuration fails with force=%s', async (force) => {
    const ctx = setup('plan', force)
    ctx.request.mockRejectedValueOnce(new Error('Plan collaboration mode is unavailable'))

    await expect(applySessionOptions(ctx.session, ctx.req, 'default')).rejects.toThrow()
    expect(ctx.request.mock.calls).toEqual([
      ['session/set_config_option', { sessionId: SESSION_ID, configId: 'collaboration_mode', value: 'plan' }]
    ])
  })

  it('supports an older Agent adapter that does not expose collaboration mode', async () => {
    const ctx = setup('agent')
    ctx.request.mockImplementation(async (method) => {
      if (method === 'session/set_config_option') throw new Error('Method not found')
      return {}
    })

    await expect(applySessionOptions(ctx.session, ctx.req, 'default')).resolves.toBeUndefined()
    expect(ctx.request).toHaveBeenCalledWith('session/set_config_option', {
      sessionId: SESSION_ID, configId: 'collaboration_mode', value: 'default'
    })
    expect(ctx.request).toHaveBeenCalledWith('session/set_mode', { sessionId: SESSION_ID, modeId: 'agent-full-access' })
  })

  it.each(['ask', 'plan', 'agent'] as const)('propagates a failed %s permission mode instead of silently continuing', async (mode) => {
    const ctx = setup(mode)
    ctx.request.mockImplementation(async (method) => {
      if (method === 'session/set_mode') throw new Error('Permission mode rejected')
      return {}
    })

    await expect(applySessionOptions(ctx.session, ctx.req, 'default')).rejects.toThrow()
    expect(ctx.request.mock.calls.filter(([method]) => method === 'session/set_mode')).toHaveLength(1)
  })
})
