import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const cliEntry = path.join(root, 'out', 'main', 'cli.cjs')

if (!fs.existsSync(cliEntry)) {
  console.error('CLI bundle not found at out/main/cli.cjs. Run "npm run build" first.')
  process.exit(1)
}

const electronBin = require('electron')
const res = spawnSync(electronBin, [cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})

if (res.error) {
  console.error(res.error.message)
  process.exit(1)
}
process.exit(res.status ?? 0)
