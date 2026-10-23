/**
 * Chromium follows the OS proxy. A Codex process started from a desktop shortcut
 * usually does not. The overlay is filled by `refreshCodexProxyEnv` and read when
 * Codex is spawned. Electron is imported only while refreshing, so CLI tests can
 * load this module without an Electron runtime.
 */

const CODEX_PROXY_URL = 'https://chatgpt.com'
const ROUTING_TIMEOUT = 'workspace routing discovery timed out'
const LOCAL_NO_PROXY = 'localhost,127.0.0.1,::1'

let overlay: NodeJS.ProcessEnv = {}

export function codexProxyOverlay(): NodeJS.ProcessEnv {
  return { ...overlay }
}

/** First non-DIRECT rule from `session.resolveProxy`, without replacing variables the user already set. */
export function proxyEnvFrom(result: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  for (const rule of result.split(';')) {
    const match = /^(PROXY|HTTPS|SOCKS4|SOCKS5|SOCKS)\s+(\S+)$/i.exec(rule.trim())
    if (!match) continue
    const kind = match[1].toUpperCase()
    const endpoint = match[2]
    if (kind === 'PROXY' || kind === 'HTTPS') {
      if (envHas(env, 'HTTP_PROXY') || envHas(env, 'HTTPS_PROXY')) return {}
      return withLocalBypass(env, {
        HTTP_PROXY: proxyUrl('http', endpoint),
        HTTPS_PROXY: proxyUrl('http', endpoint)
      })
    }
    if (envHas(env, 'ALL_PROXY')) return {}
    const scheme = kind === 'SOCKS4' ? 'socks4' : 'socks5'
    return withLocalBypass(env, { ALL_PROXY: proxyUrl(scheme, endpoint) })
  }
  return {}
}

export function isCodexRoutingTimeout(text: string | undefined): boolean {
  return !!text && text.includes(ROUTING_TIMEOUT)
}

/** Reads the system proxy for ChatGPT. A supplied resolver keeps tests off Electron. */
export async function refreshCodexProxyEnv(resolveProxy: () => Promise<string> = resolveSystemProxy): Promise<NodeJS.ProcessEnv> {
  try {
    overlay = proxyEnvFrom(await resolveProxy())
  } catch {
    overlay = {}
  }
  return codexProxyOverlay()
}

async function resolveSystemProxy(): Promise<string> {
  const { session } = await import('electron')
  return session.defaultSession.resolveProxy(CODEX_PROXY_URL)
}

function proxyUrl(scheme: string, endpoint: string): string {
  return endpoint.includes('://') ? endpoint : `${scheme}://${endpoint}`
}

function withLocalBypass(env: NodeJS.ProcessEnv, patch: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (envHas(env, 'NO_PROXY')) return patch
  return { ...patch, NO_PROXY: LOCAL_NO_PROXY }
}

function envHas(env: NodeJS.ProcessEnv, name: string): boolean {
  const target = name.toLowerCase()
  return Object.entries(env).some(([key, value]) => key.toLowerCase() === target && !!value?.trim())
}
