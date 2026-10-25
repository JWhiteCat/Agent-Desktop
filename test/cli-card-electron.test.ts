import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { build } from 'vite'
import { canRunElectronUi } from './helpers/electron-ui-environment'
import type {} from './helpers/cli-card-ui-fixture'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-cli-card-ui-'))

afterAll(() => {
  const resolved = path.resolve(directory)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-cli-card-ui-')) throw new Error('Unexpected test directory')
  fs.rmSync(resolved, { recursive: true, force: true })
})

it.runIf(canRunElectronUi)('checks cached detection, refresh actions and stale responses in real React', async () => {
  await build({ configFile: false, publicDir: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    resolve: { alias: { '@shared': path.resolve('src/shared') } },
    esbuild: { jsx: 'automatic', jsxDev: false },
    build: { target: 'chrome120', outDir: directory, emptyOutDir: false,
      lib: { entry: path.resolve('test/helpers/cli-card-ui-fixture.tsx'), formats: ['iife'], name: 'CliCardChecks', fileName: () => 'fixture.js' },
      rollupOptions: { external: ['mermaid'], output: { inlineDynamicImports: true } }
    }
  })
  const html = path.join(directory, 'index.html')
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>')
  const runner = path.join(directory, 'runner.cjs')
  fs.writeFileSync(runner, `
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(async () => {
  const win = new BrowserWindow({show:false, webPreferences:{backgroundThrottling:false}});
  win.webContents.on('console-message', event => console.error(event.message));
  await win.loadFile(${JSON.stringify(html)});
  const checks = await win.webContents.executeJavaScript('Promise.resolve().then(() => CliCardChecks.runCliCardChecks()).catch(error => ({error:error.stack || String(error)}))');
  if (checks.error) throw new Error(checks.error);
  fs.writeFileSync(${JSON.stringify(path.join(directory, 'result.json'))}, JSON.stringify(checks));
  win.destroy();
  app.quit();
}).catch(error => {console.error(error.stack || error); app.exit(1)});
`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron') as string
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(electron, [runner], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI card UI test timed out: ' + output)) }, 40_000)
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolve({ code, output }) })
  })
  expect(result.code, result.output).toBe(0)
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'))).toEqual([
    'cached reads', 'language changes', 'manual refresh', 'refresh errors', 'login and update', 'configuration changes', 'stale responses'
  ])
}, 60_000)
