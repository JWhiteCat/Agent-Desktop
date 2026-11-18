import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

export interface AntigravityGateway {
  endpoint: string
  close: () => void
}

const carbonGeneration = /\/models\/gemini-4-carbon(?=:(?:streamGenerateContent|generateContent)$)/
const qualifiedModelName = /^models\/([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*)$/i

function carbonAlias(body: Buffer): string | undefined {
  try {
    const level = JSON.parse(body.toString('utf8'))?.generationConfig?.thinkingConfig?.thinkingLevel
    if (typeof level === 'string' && /^(low|medium|high)$/i.test(level)) return `gemini-4-carbon-${level.toLowerCase()}`
  } catch {
    // Let the upstream validate the original body.
  }
}

function forwardHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result = { ...headers }
  const connectionHeaders = (headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase())
  for (const name of ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', ...connectionHeaders]) delete result[name]
  return result
}

/** agy sends Carbon's thinking level in JSON and strips it from the Gemini API model path. */
export async function openAntigravityGateway(endpoint: string): Promise<AntigravityGateway> {
  const base = new URL(endpoint)
  const transport = base.protocol === 'https:' ? https : http
  const loopback = base.hostname === 'localhost' || base.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(base.hostname)
  const agent = new transport.Agent({ keepAlive: true, proxyEnv: loopback ? undefined : process.env })
  const prefix = `/${randomUUID()}`
  const catalogs = new Map<string, Promise<string[]>>()

  function listModels(url: URL, requestHeaders: http.IncomingHttpHeaders): Promise<string[]> {
    const headers: http.OutgoingHttpHeaders = {}
    for (const name of ['x-goog-api-key', 'authorization']) {
      const value = requestHeaders[name]
      if (value !== undefined) headers[name] = value
    }
    return new Promise<string[]>((resolve, reject) => {
      const request = transport.get(url, {
        agent, signal: AbortSignal.timeout(3000), headers
      }, (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          resolve([])
          return
        }
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => {
          try {
            const { models } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            resolve(Array.isArray(models) ? models.flatMap((model) => {
              const name = typeof model?.name === 'string' ? qualifiedModelName.exec(model.name)?.[1] : undefined
              return name ? [name] : []
            }) : [])
          } catch {
            resolve([])
          }
        })
      })
      request.on('error', reject)
    }).catch(() => [])
  }

  async function advertisedAlias(target: URL, alias: string, headers: http.IncomingHttpHeaders): Promise<string | undefined> {
    const catalog = new URL(base)
    catalog.pathname = target.pathname.slice(0, target.pathname.lastIndexOf('/models/') + '/models'.length)
    let listing = catalogs.get(catalog.href)
    if (!listing) {
      listing = listModels(catalog, headers)
      catalogs.set(catalog.href, listing)
    }
    const models = await listing
    return models.find((id) => id === alias)
      ?? models.find((id) => id === `agy/${alias}`)
      ?? models.find((id) => id.endsWith(`/${alias}`))
  }

  const server = http.createServer((req, res) => {
    const path = req.url?.slice(prefix.length)
    if (!req.url?.startsWith(`${prefix}/`) || !path) {
      req.resume()
      res.writeHead(404).end()
      return
    }
    const fail = () => {
      if (res.destroyed) return
      if (res.headersSent) res.destroy()
      else res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: { code: 502, message: 'Could not reach the configured Antigravity API endpoint' }
      }))
    }
    void (async () => {
      const incoming = new URL(`http://127.0.0.1${path}`)
      const basePath = base.pathname.replace(/\/$/, '')
      const target = new URL(base)
      target.pathname = basePath + incoming.pathname
      for (const [key, value] of incoming.searchParams) target.searchParams.append(key, value)

      let body: Buffer | undefined
      let alias: string | undefined
      if (req.method === 'POST' && carbonGeneration.test(incoming.pathname)) {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        body = Buffer.concat(chunks)
        alias = carbonAlias(body)
      }
      if (res.destroyed) return

      function relay(response: http.IncomingMessage): void {
        response.on('error', fail)
        res.writeHead(response.statusCode ?? 502, forwardHeaders(response.headers))
        response.pipe(res)
      }

      function forward(url: URL, retryOriginal = false, rejectedAlias?: http.IncomingMessage): void {
        const onError = () => {
          if (res.destroyed) return
          if (rejectedAlias && !rejectedAlias.destroyed && !res.headersSent) relay(rejectedAlias)
          else fail()
        }
        const upstream = transport.request(url, {
          method: req.method, headers: { ...forwardHeaders(req.headers), host: url.host }, agent
        }, (response) => {
          if (res.destroyed) {
            response.destroy()
            return
          }
          if (retryOriginal && (response.statusCode === 403 || response.statusCode === 404)) {
            // A gateway that only knows the base ID can still serve the turn.
            response.on('error', fail)
            forward(target, false, response)
            return
          }
          if (rejectedAlias && (response.statusCode ?? 502) >= 400) {
            response.destroy()
            onError()
            return
          }
          rejectedAlias?.destroy()
          relay(response)
        })
        res.once('close', () => {
          if (!res.writableFinished) upstream.destroy()
        })
        upstream.on('error', onError)
        req.on('error', () => upstream.destroy())
        if (body) upstream.end(body)
        else req.pipe(upstream)
      }

      if (alias) {
        const advertised = await advertisedAlias(target, alias, req.headers)
        if (res.destroyed) return
        const aliased = new URL(target)
        aliased.pathname = basePath + incoming.pathname.replace(carbonGeneration, `/models/${advertised ?? alias}`)
        forward(aliased, !advertised)
      } else {
        forward(target)
      }
    })().catch(fail)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Could not start the Antigravity API gateway')
    server.unref()
    return {
      endpoint: `http://127.0.0.1:${address.port}${prefix}`,
      close: () => {
        if (!server.listening) return
        server.close()
        server.closeAllConnections()
        agent.destroy()
      }
    }
  } catch (error) {
    server.close()
    agent.destroy()
    throw error
  }
}
