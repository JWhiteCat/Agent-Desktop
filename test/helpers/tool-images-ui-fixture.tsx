import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { setLanguage } from '../../src/shared/i18n'
import type { ToolItem } from '../../src/shared/types'
import type { ToolImageData, ToolImageRef } from '../../src/shared/tool-images'
import { ToolRow } from '../../src/renderer/src/components/items/ToolRow'

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0))
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function eventually(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3_000
  while (!predicate() && Date.now() < deadline) await pause()
  check(predicate(), message)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
type Prepared = { images: ToolImageRef[]; error?: string; retryable?: boolean }

export async function runToolImageChecks() {
  const root = createRoot(document.getElementById('root')!)
  const pixel = document.createElement('canvas')
  pixel.width = 1; pixel.height = 1
  const png = pixel.toDataURL('image/png').split(',')[1]
  const calls: string[][] = []
  const reads: string[][] = []
  const pending: ReturnType<typeof deferred<Prepared>>[] = []
  const image: ToolImageRef = { id: 'image', key: 'key', name: 'pixel.png', mimeType: 'image/png', size: 68, sourceKind: 'result' }
  let readFails = true
  window.api = {
    prepareToolImages: (threadId: string, itemId: string) => {
      calls.push([threadId, itemId])
      const request = deferred<Prepared>()
      pending.push(request)
      return request.promise
    },
    readToolImage: async (threadId: string, itemId: string, imageId: string): Promise<ToolImageData> => {
      reads.push([threadId, itemId, imageId])
      if (readFails) throw new Error('temporary read failure')
      return { ...image, path: '/cache/pixel.png', data: png }
    }
  } as unknown as typeof window.api
  setLanguage('en')
  const item = (id: string, status: ToolItem['status']): ToolItem => ({ id, callId: id, kind: 'tool', tool: 'read', status, startedAt: 0, args: { path: '/pixel.png' }, images: [image] })
  const render = async (id: string, status: ToolItem['status'] = 'success') => { flushSync(() => root.render(<ToolRow threadId="thread" item={item(id, status)} />)); await pause() }
  const click = async (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector)
    check(element, `Missing ${selector}`)
    flushSync(() => element.click())
    await pause()
  }
  try {
    await render('first')
    check(calls.length === 0 && Number(reads.length) === 0, 'A mounted collapsed row does not load images')
    await click('.step-head')
    await eventually(() => calls.length === 1, 'Expansion prepares images')
    check(JSON.stringify(calls[0]) === JSON.stringify(['thread', 'first']), 'Expansion uses the current thread and item')
    pending[0].resolve({ images: [], error: 'temporary prepare failure', retryable: true })
    await eventually(() => !!document.querySelector('.tool-images > button'), 'Preparation error exposes retry')
    await click('.tool-images > button')
    await eventually(() => calls.length === 2, 'Retry issues another preparation request')
    pending[1].resolve({ images: [image] })
    await eventually(() => !!document.querySelector('.tool-image > button'), 'Image read failure exposes retry')
    check(document.body.textContent?.includes('temporary read failure'), 'Read error is displayed')
    check(JSON.stringify(reads) === JSON.stringify([['thread', 'first', 'image']]), 'Prepared image is read exactly once')
    readFails = false
    await click('.tool-image > button')
    await eventually(() => document.querySelector<HTMLImageElement>('.tool-image img')?.naturalWidth === 1, 'Image retry displays decoded image bytes')
    check(reads.length === 2, 'Retry performs a new image read')
    await click('.step-head')
    check(!document.querySelector('.tool-images'), 'Collapse unmounts image content')
    await click('.step-head')
    await eventually(() => calls.length === 3, 'Reopening starts a fresh preparation')
    await render('second')
    await eventually(() => calls.length === 4, 'Changing item starts its own preparation')
    check(JSON.stringify(calls[3]) === JSON.stringify(['thread', 'second']), 'Changed item has the right request identity')
    await render('second', 'running')
    await eventually(() => calls.length === 5, 'A status update refreshes the still-mounted image component')
    pending[4].resolve({ images: [], error: 'current result', retryable: false })
    await eventually(() => document.body.textContent?.includes('current result') === true, 'Current result is rendered')
    pending[2].resolve({ images: [], error: 'obsolete unmounted item', retryable: true })
    pending[3].resolve({ images: [], error: 'obsolete result', retryable: true })
    await pause()
    await render('second', 'running')
    check(document.body.textContent?.includes('current result') && !document.body.textContent?.includes('obsolete'), 'An obsolete response cannot replace the current item')
    await click('.step-head')
    await click('.step-head')
    await eventually(() => calls.length === 6, 'Reopening current item requests preparation')
    await click('.step-head')
    pending[5].resolve({ images: [image] })
    await pause()
    check(!document.querySelector('.tool-images') && reads.length === 2, 'A response after collapse cannot mount or read images')
    return ['collapsed mount', 'expand and retry', 'read retry', 'stale item response', 'collapsed response']
  } finally {
    flushSync(() => root.unmount())
  }
}
