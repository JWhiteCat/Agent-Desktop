import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveExitCode(res) {
  if (res.error) return 1
  if (typeof res.status === 'number') return res.status
  if (res.signal) {
    const sigNum = os.constants.signals[res.signal]
    return typeof sigNum === 'number' ? 128 + sigNum : 1
  }
  return 1
}

function main() {
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
  }
  process.exit(resolveExitCode(res))
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isDirectRun) main()
