import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { setLanguage } from '../../src/shared/i18n'
import type { CliInfo, CliProvider } from '../../src/shared/types'
import { CliCard } from '../../src/renderer/src/components/settings/CliCard'
import { getState } from '../../src/renderer/src/store'

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

export async function runCliCardChecks() {
  const calls: { provider: string | undefined; refresh: boolean | undefined }[] = []
  const saved: string[] = []
  let next: Promise<CliInfo> | undefined
  let revision = 0
  let pathValue = ''
  let keyValue = ''
  const result = (): CliInfo => ({ found: true, version: `version-${++revision}`, path: '/agent', status: 'Signed in' })
  window.api = {
    cliInfo: async (provider?: CliProvider, refresh?: boolean) => {
      calls.push({ provider, refresh })
      const response = next ?? Promise.resolve(result())
      next = undefined
      return response
    },
    login: async () => 'Logged in',
    updateCli: async () => 'Updated',
    listModels: async () => [{ id: 'auto', label: 'Auto' }]
  } as unknown as typeof window.api

  const card = () => <CliCard provider="cursor" pathValue={pathValue} keyValue={keyValue}
    pathPlaceholder="auto" pathDesc="path" keyPlaceholder="key" keyDesc="key"
    missing="Missing" install="Install"
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

  await click('Log in / Log in again')
  await idle()
  check(calls.at(-1)?.refresh === true, 'Login forces detection')
  await click('Update')
  await idle()
  check(calls.at(-1)?.refresh === true, 'Update forces detection')
  const pathCall = calls.length
  await edit(1, '/new-agent')
  check(saved.at(-1) === '/new-agent' && calls.slice(pathCall).some((call) => call.refresh === true), 'Saving path forces detection')
  const keyCall = calls.length
  await edit(0, 'new-api-key')
  check(saved.at(-1) === 'new-api-key' && calls.slice(keyCall).some((call) => call.refresh === true), 'Saving API key forces detection')

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
  root.unmount()
  return ['cached reads', 'language changes', 'manual refresh', 'refresh errors', 'login and update', 'configuration changes', 'stale responses']
}
