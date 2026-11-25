import * as electron from 'electron'

type FetchFn = typeof globalThis.fetch

function electronNetFetch(): FetchFn | undefined {
  if (!electron || typeof electron !== 'object') return undefined
  const net = (electron as { net?: { fetch?: FetchFn } }).net
  return typeof net?.fetch === 'function' ? net.fetch.bind(net) : undefined
}

/**
 * Uses Chromium's `net.fetch` (which follows the OS proxy) when running in Electron,
 * and falls back to Node's built-in `fetch` when running headless (`ELECTRON_RUN_AS_NODE=1`).
 */
export const runtimeFetch: FetchFn = (input, init) => {
  const fn = electronNetFetch() ?? globalThis.fetch
  return fn(input, init)
}
