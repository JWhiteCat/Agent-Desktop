import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { setLanguage } from '../../src/shared/i18n'
import { DEFAULT_SETTINGS, type CliInfo, type CliProvider } from '../../src/shared/types'
import { listSessionUsage, summarizeUsage } from '../../src/shared/usage'
import { CliCard } from '../../src/renderer/src/components/settings/CliCard'
import { SettingsDialog } from '../../src/renderer/src/components/settings/SettingsDialog'
import { getState, setState } from '../../src/renderer/src/store'

const root = createRoot(document.getElementById('root')!)
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function eventually(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3_000
  while (!predicate() && Date.now() < deadline) await pause()
  check(predicate(), message)
}

function button(label: string) {
  const element = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === label)
  check(element, `Missing button: ${label}`)
  return element
}

function deferred() {
  let resolve!: (info: CliInfo) => void
  const promise = new Promise<CliInfo>((yes) => { resolve = yes })
  return { promise, resolve }
}

async function checkUsageTabs(click: (label: string) => Promise<void>) {
  const reports: string[] = []
  const quotas: string[] = []
  let finishPeriod!: () => void
  const waitForPeriod = new Promise<void>((resolve) => { finishPeriod = resolve })
  let finishCursor!: () => void
  const waitForCursor = new Promise<void>((resolve) => { finishCursor = resolve })
  window.api.usageSummary = async (period, cli) => {
    check(cli, 'Usage requests specify a CLI')
    reports.push(`${cli}/${period}`)
    if (cli === 'claude' && period === '30d') await waitForPeriod
    if (cli === 'cursor') await waitForCursor
    const threads = Array.from({ length: 21 }, (_, i) => ({
      id: String(i), cli, title: `${cli} session #${i + 1}#`, items: []
    }))
    return { summary: summarizeUsage(threads, period), sessions: listSessionUsage(threads) }
  }
  window.api.usageQuota = async (provider) => {
    quotas.push(provider)
    if (provider === 'cursor') await waitForCursor
    return { provider, windows: [], note: `${provider} account quota` }
  }
  const shows = (text: string) => document.body.textContent?.includes(text) === true
  const selected = () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent

  await click('Usage')
  await eventually(() => shows('claude session #1#'), 'Usage opens for the configured CLI')
  check(selected() === 'Claude' && reports.at(-1) === 'claude/7d' && !quotas.length, 'Default period and scoped quota')
  await click('30 days')
  await click('Next')
  check(shows('claude session #21#'), 'Lifetime history is available while the new period loads')
  finishPeriod()
  await click('Cursor')
  check(!shows('claude session #21#'), 'Switching CLI clears the previous history immediately')
  await click('Codex')
  await eventually(() => shows('codex session #1#') && shows('codex account quota'), 'CLI switch opens the first page')
  check(reports.at(-1) === 'codex/30d' && !shows('codex session #21#'), 'CLI switch preserves the usage period')
  finishCursor()
  await pause()
  check(!shows('cursor session #1#') && !shows('cursor account quota'), 'Late results stay out of the selected tab')
  await click('Refresh')
  check(quotas.join(',') === 'cursor,codex,codex', 'Quota refresh targets only the selected provider')
  await click('Antigravity')
  check(!document.querySelector('.quota-card') && quotas.length === 3, 'Antigravity only displays local usage')
  await click('Models')
  check(selected() === 'Claude', 'Models keeps an independent CLI selection')
  await click('Usage')
  check(selected() === 'Antigravity', 'Usage remembers its CLI when revisited')
}

export async function runCliCardChecks() {
  const calls: { provider: string | undefined; refresh: boolean | undefined }[] = []
  const saved: string[] = []
  const savedApi: { key: string; endpoint: string }[] = []
  const logins: (CliProvider | undefined)[] = []
  const updates: (CliProvider | undefined)[] = []
  let next: Promise<CliInfo> | undefined
  let revision = 0
  let pathValue = ''
  let keyValue = ''
  let endpointValue = ''
  let provider: CliProvider = 'cursor'
  const result = (): CliInfo => ({ found: true, version: `version-${++revision}`, path: '/agent', status: 'Signed in' })
  window.api = {
    cliInfo: async (provider?: CliProvider, refresh?: boolean) => {
      calls.push({ provider, refresh })
      const response = next ?? Promise.resolve(result())
      next = undefined
      return response
    },
    login: async (provider?: CliProvider) => { logins.push(provider); return 'Logged in' },
    updateCli: async (provider?: CliProvider) => { updates.push(provider); return 'Updated' },
    listModels: async () => [{ id: 'auto', label: 'Auto' }]
  } as unknown as typeof window.api

  const card = () => <CliCard active key={provider} provider={provider} pathValue={pathValue} keyValue={keyValue}
    pathPlaceholder="auto" pathDesc="path" keyPlaceholder="key" keyDesc="key"
    missing="Missing" install="Install"
    endpoint={provider === 'antigravity' ? { value: endpointValue, onSave: async (key, endpoint) => {
      savedApi.push({ key, endpoint })
      keyValue = key
      endpointValue = endpoint
      render()
    } } : undefined}
    onPath={async (value) => { saved.push(value); pathValue = value; render() }}
    onKey={async (value) => { saved.push(value); keyValue = value; render() }} />
  function render() { flushSync(() => root.render(card())) }
  async function idle() {
    await eventually(() => !button('Check again').disabled, 'Detection should finish')
  }
  async function click(label: string) {
    flushSync(() => button(label).click())
    await pause()
  }
  async function edit(index: number, value: string) {
    const input = document.querySelectorAll('input')[index]
    check(input, 'Input exists')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })))
    flushSync(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await pause()
    await idle()
  }

  setLanguage('en')
  render()
  await idle()
  check(calls.length === 1 && calls[0].provider === 'cursor' && calls[0].refresh === false, 'Mount requests cached info')
  const count = calls.length
  flushSync(() => setLanguage('zh-CN'))
  await pause()
  check(document.body.textContent?.includes('重新检测'), 'Labels switch language')
  check(calls.length === count, 'Language changes do not request CLI info')
  flushSync(() => setLanguage('en'))
  flushSync(() => root.render(null))
  render()
  await idle()
  check(calls.length === count + 1 && calls.at(-1)?.refresh === false, 'Reopening reads cached info')

  const pending = deferred()
  next = pending.promise
  const previousText = document.querySelector('.cli-card')?.textContent
  await click('Check again')
  check(calls.at(-1)?.refresh === true, 'Check again forces detection')
  check(button('Check again').disabled, 'Refresh is disabled while pending')
  check(document.querySelector('.cli-card')?.textContent === previousText, 'Existing results remain visible while refreshing')
  pending.resolve({ found: true, version: 'manually-refreshed', status: 'Signed in' })
  await idle()
  check(document.body.textContent?.includes('manually-refreshed'), 'Manual refresh updates displayed info')

  next = Promise.reject(new Error('detection failed'))
  await click('Check again')
  await idle()
  check(document.body.textContent?.includes('manually-refreshed'), 'Detection errors preserve displayed results')
  check(getState().toast?.text.includes('detection failed'), 'Detection errors show a toast')

  const beforeLogin = calls.length
  await click('Log in / Log in again')
  await eventually(() => calls.length > beforeLogin, 'Login starts a new detection')
  await idle()
  check(logins.length === 1 && logins[0] === 'cursor', 'Login calls the selected provider exactly once')
  check(calls.length === beforeLogin + 1 && calls.at(-1)?.provider === 'cursor' && calls.at(-1)?.refresh === true, 'Login forces exactly one new detection')
  const beforeUpdate = calls.length
  await click('Update')
  await eventually(() => calls.length > beforeUpdate, 'Update starts a new detection')
  await idle()
  check(updates.length === 1 && updates[0] === 'cursor', 'Update calls the selected provider exactly once')
  check(calls.length === beforeUpdate + 1 && calls.at(-1)?.provider === 'cursor' && calls.at(-1)?.refresh === true, 'Update forces exactly one new detection')
  check(document.querySelector('[role="status"]')?.textContent === 'Updated', 'Update result is visible')
  const pathCall = calls.length
  await edit(1, '/new-agent')
  check(saved.at(-1) === '/new-agent' && calls.slice(pathCall).some((call) => call.refresh === true), 'Saving path forces detection')
  const keyCall = calls.length
  await edit(0, 'new-api-key')
  check(saved.at(-1) === 'new-api-key' && calls.slice(keyCall).some((call) => call.refresh === true), 'Saving API key forces detection')
  const keyInput = () => document.querySelector<HTMLInputElement>('input[aria-label="API Key"]')!
  const toggleKey = (label: string) => {
    const toggle = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    check(toggle, `Missing visibility button: ${label}`)
    flushSync(() => toggle.click())
  }
  check(keyInput().type === 'password', 'API key starts hidden')
  toggleKey('Show API key')
  check(keyInput().type === 'text' && keyInput().value === 'new-api-key', 'Eye reveals the current key')
  toggleKey('Hide API key')
  check(keyInput().type === 'password' && keyInput().value === 'new-api-key', 'Eye hides the same key')

  const old = deferred()
  next = old.promise
  await click('Check again')
  pathValue = '/external-change'
  render()
  await idle()
  const latestText = document.querySelector('.cli-card')?.textContent
  old.resolve({ found: true, version: 'obsolete-result' })
  await pause()
  check(document.querySelector('.cli-card')?.textContent === latestText, 'Superseded detection cannot overwrite the card')

  const terminalGuide = () => document.querySelector<HTMLAnchorElement>('.cli-card a')
  check(!terminalGuide(), 'Cursor card has no agy installation link')
  provider = 'antigravity'
  next = Promise.resolve({ found: true, source: 'managed', path: '/agy', version: '1.5.11' })
  render()
  await idle()
  check(document.querySelector('.cli-card')?.textContent?.includes('Use the path above to run agy in a terminal.'), 'Managed Antigravity shows how to use its binary in a terminal')
  check(!terminalGuide(), 'Managed Antigravity already has the terminal binary')
  next = Promise.resolve({ found: false })
  await click('Check again')
  await idle()
  check(terminalGuide()?.href === 'https://antigravity.google/docs/getting-started?tab=cli', 'Missing Antigravity links to the official CLI guide')
  next = Promise.resolve({ found: true, source: 'external', path: '/agy', version: '1.5.11' })
  await click('Check again')
  await idle()
  check(!terminalGuide(), 'Detected standalone Antigravity hides terminal setup')
  const previousKeySaves = saved.length
  await edit(0, 'paired-key')
  await edit(1, 'https://gemini.example/v1beta')
  check(saved.length === previousKeySaves && !savedApi.length, 'Editing either API field does not apply a partial configuration')
  await click('Save API configuration')
  await idle()
  check(savedApi.at(-1)?.key === 'paired-key' && savedApi.at(-1)?.endpoint === 'https://gemini.example/v1beta', 'Antigravity saves the API key and endpoint together')
  check(button('Save API configuration').disabled, 'Saved API configuration leaves the button disabled')
  setState({ app: { ...getState().app, settings: { ...DEFAULT_SETTINGS, cliProvider: 'claude', language: 'en' } } })
  flushSync(() => root.render(<SettingsDialog onClose={() => {}} onOpenImport={() => {}} />))
  check(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === 'Claude', 'Open on the configured default CLI')
  const defaultCli = document.querySelector('select')!.value
  for (const name of ['Codex', 'Claude', 'Antigravity', 'Cursor']) {
    await click(name)
    const panels = document.querySelectorAll('[role="tabpanel"]:not([hidden])')
    const selected = document.querySelector('[role="tab"][aria-selected="true"]')
    check(panels.length === 1 && selected?.textContent === name && panels[0].getAttribute('aria-labelledby') === selected.id, 'Only the selected provider is displayed')
    check(document.querySelector('select')!.value === defaultCli, 'Browsing providers preserves the default CLI')
  }
  await checkUsageTabs(click)
  root.unmount()
  return ['cached reads', 'language changes', 'manual refresh', 'refresh errors', 'login and update', 'configuration changes', 'stale responses', 'Antigravity terminal setup', 'per-CLI usage tabs']
}
