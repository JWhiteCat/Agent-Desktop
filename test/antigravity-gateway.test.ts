import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { openAntigravityGateway } from '../src/main/antigravity-gateway'

const API_PATH = '/v1beta/models/'
const STREAM_ACTION = ':streamGenerateContent?alt=sse'
const CARBON = 'gemini-4-carbon'
const stream = 'data: {"candidates":[{"finishReason":"STOP"}]}\n\n'
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})

async function setup(allowed: string, level = 'high', models?: string[]) {
  const body = JSON.stringify({ generationConfig: { thinkingConfig: { thinkingLevel: level.toUpperCase() } } })
  const requests: { url?: string; key?: string | string[]; body: string }[] = []
  const catalogs: { url?: string; key?: string | string[] }[] = []
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      catalogs.push({ url: req.url, key: req.headers['x-goog-api-key'] })
      if (models) res.writeHead(200).end(JSON.stringify({ models: models.map((name) => ({ name })) }))
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
  const gateway = await openAntigravityGateway(`http://127.0.0.1:${address.port}/prefix/`)
  cleanups.push(gateway.close)
  const send = (model: string) => fetch(`${gateway.endpoint}${API_PATH}${model}${STREAM_ACTION}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': 'fixture-key' }, body
  })
  return { requests, catalogs, send, body }
}

describe('Antigravity custom gateway', () => {
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
