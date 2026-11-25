import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    environment: 'node',
    // macOS /var is a link to /private/var; fixture expectations and child cwd must agree.
    ...(process.platform === 'darwin' ? { env: { TMPDIR: realpathSync(tmpdir()) } } : {}),
    // Cap default workers on Windows (matching CI --maxWorkers=4) to avoid saturating subprocess-heavy suites.
    ...(process.platform === 'win32' ? { maxWorkers: 4 } : {}),
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**', '**/node_modules/**', 'out/**', 'release/**']
  }
})
