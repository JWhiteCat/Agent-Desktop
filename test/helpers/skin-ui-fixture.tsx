import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { DEFAULT_SKIN, type SkinConfig } from '../../src/shared/skins'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { SkinBackground } from '../../src/renderer/src/components/SkinBackground'
import { setState } from '../../src/renderer/src/store'
import '../../src/renderer/src/styles.css'

const source = { id: 'a'.repeat(32), title: 'Resize fixture', kind: 'web' as const, root: '', entry: 'index.html', properties: {} }
const skin: SkinConfig = { ...DEFAULT_SKIN, background: 'web', sourceId: source.id, fit: 'contain' }
window.api = { isRemote: false, skinSource: async () => source } as unknown as typeof window.api
setState({ app: { projects: [], threads: [], running: [], settings: { ...DEFAULT_SETTINGS, skin } } })
createRoot(document.getElementById('root')!).render(<div className="app"><SkinBackground /></div>)

export function changeFit(fit: SkinConfig['fit']) {
  flushSync(() => setState({ skinPreview: { ...skin, fit } }))
}
