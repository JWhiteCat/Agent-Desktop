import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listAntigravityModels } from '../src/main/antigravity'
import { openAntigravityGateway } from '../src/main/antigravity-gateway'
import { applySessionOptions, type SessionConnection } from '../src/main/session/provider'

const API_PATH = '/v1beta/models/'
const STREAM_ACTION = ':streamGenerateContent?alt=sse'
const CARBON = 'gemini-4-carbon'
const stream = 'data: {"candidates":[{"finishReason":"STOP"}]}\n\n'
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})

async function setup(allowed: string, level = 'high', models?: (string | { name: string; displayName: string })[]) {
  const body = JSON.stringify({ generationConfig: { maxOutputTokens: 100, thinkingConfig: { thinkingLevel: level.toUpperCase() } } })
  const requests: { url?: string; key?: string | string[]; body: string }[] = []
  const catalogs: { url?: string; key?: string | string[] }[] = []
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      catalogs.push({ url: req.url, key: req.headers['x-goog-api-key'] })
      if (models) res.writeHead(200).end(JSON.stringify({
        models: models.map((model) => typeof model === 'string' ? { name: model } : model)
      }))
      else res.writeHead(405).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ url: req.url, key: req.headers['x-goog-api-key'], body: Buffer.concat(chunks).toString() })
    if (req.url !== `/prefix${API_PATH}${allowed}${STREAM_ACTION}`) {
      res.writeHead(403).end(`Model unavailable for ${req.url}`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(stream)
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => { upstream.close(); upstream.closeAllConnections() })
  const address = upstream.address() as { port: number }
  const endpoint = `http://127.0.0.1:${address.port}/prefix/`
  const gateway = await openAntigravityGateway(endpoint)
  cleanups.push(gateway.close)
  const send = (model: string) => fetch(`${gateway.endpoint}${API_PATH}${model}${STREAM_ACTION}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': 'fixture-key' }, body
  })
  return { requests, catalogs, send, body, endpoint, gateway }
}

describe('Antigravity custom gateway', () => {
  it('lists only unique agy IDs from the authenticated gateway catalog', async () => {
    const id = 'agy/claude-opus-5-5-high'
    const label = 'Claude Opus 5.5 (High)'
    const carbon = `agy/${CARBON}-high`
    const { endpoint, catalogs } = await setup(id, 'high', [
      { name: `models/${id}`, displayName: label },
      `models/${id}`,
      { name: `models/${carbon}`, displayName: 'Gemini 4 Carbon (High)' },
      `models/${CARBON}`,
      'models/other/claude-opus-5-5-high',
      'models/AGY/claude-opus-5-5-high',
      'models/agy/../invalid'
    ])
    expect(await listAntigravityModels('./missing-agy', { endpoint, apiKey: 'fixture-key' })).toEqual([
      { id, label, legacySlug: 'claude-opus-5-5[effort=high]' },
      { id: carbon, label: 'Gemini 4 Carbon (High)', legacySlug: `${CARBON}[effort=high]` }
    ])
    expect(catalogs).toEqual([{ url: '/prefix/v1beta/models', key: 'fixture-key' }])
  })

  it('keeps the gateway list empty when its catalog is unavailable', async () => {
    const { endpoint } = await setup(CARBON)
    expect(await listAntigravityModels('./missing-agy', { endpoint, apiKey: 'fixture-key' })).toEqual([])
  })

  it('routes an ACP-unlisted model to its full ID and clears the route on Auto', async () => {
    const id = 'agy/claude-opus-5-5-high'
    const cliId = 'gemini-3.1-pro'
    const cliApiId = 'gemini-3.1-pro-preview'
    const { gateway, send, requests, body } = await setup(id)
    const defaults = [{
      type: 'select', id: 'model', currentValue: cliId, options: [{ value: cliId }, { value: CARBON }]
    }]
    const request = vi.fn(async () => ({ configOptions: defaults }))
    const session: SessionConnection = {
      provider: 'antigravity', sessionId: 'agy-session', acp: { request }, antigravityGateway: gateway,
      antigravityOptions: [{ ...defaults[0], currentValue: CARBON }], antigravityDefaults: defaults
    }
    const turn = { threadId: 'thread', prompt: '', mode: 'agent', force: false } as const
    await applySessionOptions(session, { ...turn, model: id }, 'default')
    expect(request.mock.calls).toEqual([
      ['session/set_mode', { sessionId: 'agy-session', modeId: 'default' }],
      ['session/set_config_option', { sessionId: 'agy-session', configId: 'model', value: cliId }]
    ])
    expect(await (await send(cliApiId)).text()).toBe(stream)
    await applySessionOptions(session, { ...turn, model: 'auto' }, 'default')
    expect((await send(cliApiId)).status).toBe(403)
    expect(requests).toEqual([
      { url: `/prefix${API_PATH}${id}${STREAM_ACTION}`, key: 'fixture-key', body: '{"generationConfig":{"maxOutputTokens":100}}' },
      { url: `/prefix${API_PATH}${cliApiId}${STREAM_ACTION}`, key: 'fixture-key', body }
    ])
  })

  it.each(['low', 'medium', 'high'])('sends the Carbon %s alias with the original key, payload, and SSE query', async (level) => {
    const { requests, send, body } = await setup(`${CARBON}-${level}`, level)
    const response = await send(CARBON)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toBe(stream)
    expect(requests).toEqual([{ url: `/prefix${API_PATH}${CARBON}-${level}${STREAM_ACTION}`, key: 'fixture-key', body }])
  })

  it('retries the base Carbon ID once when the gateway rejects the alias', async () => {
    const { requests, send } = await setup(CARBON)
    expect(await (await send(CARBON)).text()).toBe(stream)
    expect(requests.map(({ url }) => url)).toEqual([
      `/prefix${API_PATH}${CARBON}-high${STREAM_ACTION}`, `/prefix${API_PATH}${CARBON}${STREAM_ACTION}`
    ])
  })

  it('uses and caches the qualified alias from the authenticated model catalog', async () => {
    const qualified = `agy/${CARBON}-high`
    const { requests, catalogs, send } = await setup(qualified, 'high', [`models/agy/${CARBON}`, `models/${qualified}`])
    expect(await (await send(CARBON)).text()).toBe(stream)
    expect(await (await send(CARBON)).text()).toBe(stream)
    expect(catalogs).toEqual([{ url: '/prefix/v1beta/models', key: 'fixture-key' }])
    expect(requests.map(({ url }) => url)).toEqual(Array(2).fill(`/prefix${API_PATH}${qualified}${STREAM_ACTION}`))
  })

  it('returns the advertised alias error without retrying the base ID', async () => {
    const qualified = `agy/${CARBON}-high`
    const { requests, send } = await setup(CARBON, 'high', [`models/${qualified}`])
    const response = await send(CARBON)
    expect(response.status).toBe(403)
    expect(await response.text()).toContain(qualified)
    expect(requests).toHaveLength(1)
  })

  it('reports the alias error when neither alias nor base ID works without a catalog', async () => {
    const { requests, send } = await setup('another-model')
    const response = await send(CARBON)
    expect(response.status).toBe(403)
    expect(await response.text()).toContain(`${CARBON}-high`)
    expect(requests).toHaveLength(2)
  })

  it('forwards other model IDs unchanged', async () => {
    const model = 'gemini-3.8-flash'
    const { requests, send } = await setup(model)
    expect(await (await send(model)).text()).toBe(stream)
    expect(requests.map(({ url }) => url)).toEqual([`/prefix${API_PATH}${model}${STREAM_ACTION}`])
  })
})
