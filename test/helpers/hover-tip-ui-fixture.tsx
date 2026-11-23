import { StrictMode, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { HoverTip } from '../../src/renderer/src/components/HoverTip'
import { ModelPicker } from '../../src/renderer/src/components/ModelPicker'
import { FavoriteModels } from '../../src/renderer/src/components/settings/FavoriteModels'
import { getState, setState } from '../../src/renderer/src/store'
import '../../src/renderer/src/styles.css'

const root = createRoot(document.getElementById('root')!)
const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms))
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function waitFor(condition: () => unknown, message: string, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await pause(25)
  check(condition(), message)
}
function one<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector)
  check(element, `Missing element: ${selector}`)
  return element
}
async function render(node: ReactNode) {
  flushSync(() => root.render(<StrictMode>{node}</StrictMode>))
  await pause()
}
async function pointer(element: Element, type: string, pointerType: string, relatedTarget: EventTarget | null = null) {
  flushSync(() => element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, relatedTarget })))
  await pause()
}
async function click(element: HTMLElement, pointerType = 'touch') {
  await pointer(element, 'pointerover', pointerType)
  await pointer(element, 'pointerdown', pointerType)
  await pointer(element, 'pointerup', pointerType)
  // Touch browsers also dispatch compatibility mouse events.
  flushSync(() => {
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true }))
    }
  })
  await pause()
}
function tooltip() { return document.querySelector('[role="tooltip"]') }

const fastModel = 'composer-2.5[fast=true]'
function Picker() {
  const [value, setValue] = useState(fastModel)
  return <ModelPicker value={value} cli="cursor" onChange={setValue} />
}

export async function runHoverTipChecks() {
  await render(<HoverTip text="Price"><button>Model</button></HoverTip>)
  for (const type of ['touch', 'pen']) {
    await click(one('button'), type)
    check(!tooltip(), `${type} and compatibility mouse events must not show a tooltip`)
  }
  await pointer(one('button'), 'pointerover', 'mouse')
  check(tooltip(), 'Mouse hover still shows a tooltip on a narrow screen')
  check(getComputedStyle(one('[role="tooltip"]')).position === 'fixed', 'Checks use the production tooltip styles')
  await pointer(one('button'), 'pointerout', 'mouse')
  check(!tooltip(), 'Mouse leave closes the tooltip')
  await pointer(one('button'), 'pointerover', 'mouse')
  await pointer(document.body, 'pointerdown', 'touch')
  check(!tooltip(), 'Touch elsewhere dismisses an existing mouse tooltip')

  await render(<HoverTip text="Link address" interactive><a href="#">Link</a></HoverTip>)
  await pointer(one('a'), 'pointerover', 'mouse')
  const bubble = one('[role="tooltip"]')
  await pointer(one('a'), 'pointerout', 'mouse', bubble)
  check(tooltip(), 'Interactive tooltip stays open during the crossing delay')
  await pointer(bubble, 'pointerover', 'mouse', one('a'))
  await pause(200)
  check(tooltip(), 'Moving into an interactive bubble cancels hiding')
  await pointer(bubble, 'pointerout', 'mouse')
  await waitFor(() => !tooltip(), 'Leaving the interactive bubble closes it after the delay')
  await pointer(one('a'), 'pointerover', 'mouse')
  await pointer(one('[role="tooltip"]'), 'pointerdown', 'touch')
  check(!tooltip(), 'Touching an interactive bubble dismisses it')
  await pointer(one('a'), 'pointerover', 'mouse')
  await pointer(one('a'), 'pointerout', 'mouse')
  await render(null)
  await pause(200)
  check(!tooltip(), 'Unmount removes the bubble and clears pending hiding')

  window.api = { updateSettings: async () => undefined } as unknown as typeof window.api
  const state = getState()
  setState({
    app: { ...state.app, settings: { ...DEFAULT_SETTINGS, cliProvider: 'cursor', favoriteModels: [] } },
    modelsByCli: { cursor: [
      { id: 'auto', label: 'Auto' },
      { id: 'composer-2.5', label: 'Composer 2.5' },
      { id: fastModel, label: 'Composer 2.5 Fast' }
    ], codex: [], claude: [], antigravity: [] }
  })
  await render(<Picker />)
  await pointer(one('.model-pill'), 'pointerover', 'mouse')
  check(tooltip(), 'Model pill shows price with a mouse')
  await click(one('.model-pill'), 'mouse')
  check(document.querySelector('.model-popover'), 'Model menu opens')
  check(!tooltip(), 'Opening the menu dismisses the pill price')
  await pointer(one('.model-pill'), 'pointerover', 'mouse')
  check(!tooltip(), 'Pill price remains disabled while the menu is open')
  const rows = document.querySelectorAll<HTMLButtonElement>('.model-list button')
  check(rows.length === 2, 'Both model groups are listed')
  await pointer(rows[1], 'pointerover', 'mouse')
  check(tooltip(), 'Model rows retain mouse price tooltips')
  await click(rows[0])
  check(!tooltip(), 'Touch model selection leaves no price bubble')
  check(one('.model-pill').textContent?.includes('Auto'), 'Touch changes the selected model')
  await click(rows[1])
  check(one('.model-pill').textContent?.includes('Composer'), 'Touch can select Composer again')
  const standard = Array.from(document.querySelectorAll<HTMLButtonElement>('.model-opt')).find(el => el.textContent === '标准' || el.textContent === 'Standard')
  check(standard, 'Speed parameter is available')
  await click(standard)
  check(standard.classList.contains('selected'), 'Touch can change the model speed')
  const search = one<HTMLInputElement>('.model-search input')
  await pointer(search, 'pointerdown', 'touch')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'auto')
  flushSync(() => search.dispatchEvent(new Event('input', { bubbles: true })))
  await pause()
  check(document.querySelectorAll('.model-list button').length === 1, 'Touch search filters the model list')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'no-match')
  flushSync(() => search.dispatchEvent(new Event('input', { bubbles: true })))
  await pause()
  check(!document.querySelector('.model-list button'), 'Search still filters models')
  check(!tooltip(), 'Search and parameter changes leave no tooltip')
  flushSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  await pause()
  await pointer(one('.model-pill'), 'pointerover', 'mouse')
  check(tooltip(), 'Pill mouse tooltip works again after closing the menu')
  await render(null)
  await render(<FavoriteModels provider="cursor" />)
  const favorite = one<HTMLInputElement>('.favorite-item input')
  await click(favorite)
  check(favorite.checked && !tooltip(), 'Touch toggles a favorite without a price bubble')
  await pointer(one('.favorite-item'), 'pointerover', 'mouse')
  check(tooltip(), 'Favorite models retain mouse price tooltips')
  await render(null)
  await render(<Picker />)
  return ['touch and pen', 'mouse hover', 'touch dismissal', 'interactive bubbles', 'unmount', 'picker and parameters', 'favorites']
}
