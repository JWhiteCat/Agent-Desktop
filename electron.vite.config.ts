import { resolve } from 'node:path'
import { builtinModules } from 'node:module'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { build as viteBuild } from 'vite'

export default defineConfig(({ command }) => ({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { externalizeDeps: { exclude: ['cross-spawn'] } },
    plugins: [{
      name: 'standalone-toolbar-runner',
      async closeBundle() {
        // Build separately so the terminal runner never relies on app.asar or shared main chunks.
        await viteBuild({
          configFile: false,
          publicDir: false,
          logLevel: 'warn',
          build: {
            target: 'node22',
            outDir: resolve('out/main'),
            emptyOutDir: false,
            lib: { entry: resolve('src/main/toolbar-runner.ts'), formats: ['cjs'], fileName: () => 'toolbar-runner.cjs' },
            rollupOptions: { external: (id) => id.startsWith('node:') || builtinModules.includes(id) }
          }
        })
      }
    }]
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    base: command === 'serve' ? '/' : './',
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
}))
