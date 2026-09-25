import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** Opt-in model call. Default `vitest` config never loads this directory. */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    environment: 'node',
    include: ['test/live/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'out/**', 'release/**'],
    env: { AGENT_DESKTOP_LIVE_MODEL: '1' },
    fileParallelism: false
  }
})
