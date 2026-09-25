import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**', '**/node_modules/**', 'out/**', 'release/**']
  }
})
