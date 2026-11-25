import fs from 'node:fs'
import { resolve } from 'node:path'
import { builtinModules } from 'node:module'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { build as viteBuild, type Plugin } from 'vite'

/** Copy Mermaid's prebuilt ESM bundle directly so Vite/Rollup skips re-bundling its 2k+ modules on every build. */
function prebuiltMermaidPlugin(): Plugin {
  const mermaidDist = resolve('node_modules/mermaid/dist')
  const entryName = 'mermaid.esm.min.mjs'
  const chunksSubdir = 'chunks/mermaid.esm.min'
  const virtualId = 'virtual:mermaid-prebuilt'
  const resolvedVirtualId = `\0${virtualId}`
  let isBuild = false

  return {
    name: 'prebuilt-mermaid',
    enforce: 'pre',
    configResolved(config) {
      isBuild = config.command === 'build'
    },
    resolveId(source) {
      if (isBuild && source === 'mermaid') return resolvedVirtualId
      return null
    },
    load(id) {
      if (id !== resolvedVirtualId) return null
      // Load the copied prebuilt ESM entry relative to the built index.html (works over file://, LAN, and /c/<id>/).
      return [
        `const entryUrl = new URL('./vendor/mermaid/${entryName}', document.baseURI).href`,
        'const load = () => import(/* @vite-ignore */ entryUrl)',
        'export default load'
      ].join('\n')
    },
    closeBundle() {
      if (!isBuild) return
      const targetRoot = resolve('out/renderer/vendor/mermaid')
      const targetChunks = resolve(targetRoot, chunksSubdir)
      fs.mkdirSync(targetChunks, { recursive: true })
      fs.copyFileSync(resolve(mermaidDist, entryName), resolve(targetRoot, entryName))
      fs.cpSync(resolve(mermaidDist, chunksSubdir), targetChunks, {
        recursive: true,
        force: true,
        filter: (src) => !src.endsWith('.map')
      })
    }
  }
}

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
    }, {
      name: 'standalone-cli',
      async closeBundle() {
        // Build self-contained Node CLI bundle that runs under ELECTRON_RUN_AS_NODE=1 without Electron modules.
        await viteBuild({
          configFile: false,
          publicDir: false,
          logLevel: 'warn',
          resolve: {
            alias: {
              '@shared': resolve('src/shared'),
              electron: resolve('src/cli/electron-stub.ts'),
              '@aws-sdk/client-s3': resolve('src/cli/electron-stub.ts')
            }
          },
          build: {
            target: 'node22',
            outDir: resolve('out/main'),
            emptyOutDir: false,
            lib: { entry: resolve('src/cli/index.ts'), formats: ['cjs'], fileName: () => 'cli.cjs' },
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
    plugins: [react(), prebuiltMermaidPlugin()]
  }
}))
