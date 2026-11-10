import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { build } from 'vite'
import { bridgeScript } from '../src/main/skins'
import { canRunElectronUi } from './helpers/electron-ui-environment'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-skin-resize-'))
afterAll(() => {
  const resolved = path.resolve(directory)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-skin-resize-')) throw new Error('Unexpected test directory')
  fs.rmSync(resolved, { recursive: true, force: true })
})

it.runIf(canRunElectronUi)('keeps Web background edges visible on resize and previews fit changes without reloading', async () => {
  await build({ configFile: false, publicDir: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    resolve: { alias: { '@shared': path.resolve('src/shared') } },
    esbuild: { jsx: 'automatic', jsxDev: false },
    build: { target: 'chrome120', outDir: directory, emptyOutDir: false,
      lib: { entry: path.resolve('test/helpers/skin-ui-fixture.tsx'), formats: ['iife'], name: 'SkinChecks', fileName: () => 'fixture.js', cssFileName: 'style' },
      rollupOptions: { external: ['mermaid'], output: { inlineDynamicImports: true } }
    }
  })
  // A wallpaper with a hard-coded cover background, like many Workshop projects.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><path fill="white" d="M0 0h200v100H0z"/><path fill="red" d="M0 0h5v100H0z"/><path fill="blue" d="M195 0h5v100h-5z"/></svg>'
  const wallpaper = `<html><head><style>html,body{margin:0;height:100%}body{background: center / cover no-repeat url("data:image/svg+xml,${encodeURIComponent(svg)}")}</style></head><body><script src="bridge.js"></script></body></html>`
  const bridge = bridgeScript({ id: 'a'.repeat(32), title: '', kind: 'web', root: '', entry: 'index.html', properties: {} })
  const html = path.join(directory, 'index.html')
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><div id="root"></div><script src="fixture.js"></script>')
  const runner = path.join(directory, 'runner.cjs')
  fs.writeFileSync(runner, `
const {app, BrowserWindow, protocol, screen} = require('electron');
const assert = require('node:assert/strict');
// CI desktops may disable animations; this regression exercises an active wallpaper.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
protocol.registerSchemesAsPrivileged([{scheme:'skin-asset', privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
app.whenReady().then(async () => {
  protocol.handle('skin-asset', request => new Response(request.url.endsWith('bridge.js') ? ${JSON.stringify(bridge)} : ${JSON.stringify(wallpaper)}, {headers:{'content-type':request.url.endsWith('bridge.js')?'text/javascript':'text/html'}}));
  // SkinBackground deliberately unloads Web wallpapers while the document is hidden.
  const win = new BrowserWindow({show:true, width:800, height:600, useContentSize:true, webPreferences:{backgroundThrottling:false}});
  win.webContents.on('console-message', event => console.error(event.message));
  await win.loadFile(${JSON.stringify(html)});
  assert.equal(await win.webContents.executeJavaScript('matchMedia("(prefers-reduced-motion: reduce)").matches'), false);
  const frame = () => win.webContents.mainFrame.frames.find(f => f.url.startsWith('skin-asset:'));
  const sizing = () => frame()?.executeJavaScript('getComputedStyle(document.body).backgroundSize');
  async function waitForFit(expected) {
    for (let i=0; i<60; i++) { if (await sizing() === expected) return; await pause(); }
    const state = await win.webContents.executeJavaScript('JSON.stringify({hidden:document.hidden,reduced:matchMedia("(prefers-reduced-motion: reduce)").matches,html:document.body.innerHTML})');
    throw new Error('Background fit did not become ' + expected + ': ' + state);
  }
  await waitForFit('contain');
  const originalFrame = frame();
  // macOS constrains visible windows to the CI desktop work area.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const windowScale = Math.min(1, (area.width-80)/1360, (area.height-100)/880);
  const sizes = [[800,600],[1200,600],[600,800],[1360,880]].map(([w,h]) => [Math.floor(w*windowScale),Math.floor(h*windowScale)]);
  for (const [width,height] of sizes) {
    win.setContentSize(width,height);
    for (let i=0; i<60; i++) {
      if (await frame().executeJavaScript('innerWidth + "," + innerHeight') === width+','+height) break;
      await pause();
    }
    assert.equal(await frame().executeJavaScript('innerWidth + "," + innerHeight'), width+','+height);
    const paintedWidth = Math.min(width, height * 2);
    const left = (width - paintedWidth) / 2;
    // Layout can settle before the image decode/compositor finishes its next frame.
    let edges;
    for (let i=0; i<60; i++) {
      await pause();
      const image = await win.webContents.capturePage();
      const bitmap = image.toBitmap();
      const size = image.getSize();
      const scale = size.width / width;
      function pixel(x,y) { const offset = (Math.floor(y*scale)*size.width+Math.floor(x*scale))*4; return [...bitmap.subarray(offset,offset+3)]; }
      edges = [pixel(left+2,height/2),pixel(left+paintedWidth-3,height/2)];
      if (JSON.stringify(edges) === '[[0,0,255],[255,0,0]]') break;
    }
    assert.deepEqual(edges, [[0,0,255],[255,0,0]], 'Both background edges must remain visible at '+width+'x'+height);
    assert.equal(await sizing(), 'contain');
  }
  await win.webContents.executeJavaScript('SkinChecks.changeFit("cover")');
  await waitForFit('cover');
  await win.webContents.executeJavaScript('SkinChecks.changeFit("contain")');
  await waitForFit('contain');
  assert.equal(frame(), originalFrame, 'Changing fit must preserve the running wallpaper');
  // Malformed fit values cannot inject CSS into the isolated document.
  await win.webContents.executeJavaScript('document.querySelector("iframe").contentWindow.postMessage({type:"skin-properties",fit:"cover; color: red"}, "*")');
  await pause();
  assert.equal(await sizing(), 'contain');
  win.destroy(); app.quit();
}).catch(error => {console.error(error.stack || error); app.exit(1)});
`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron') as string
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(electron, [runner], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Skin resize test timed out: ' + output)) }, 40_000)
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolve({ code, output }) })
  })
  expect(result.code, result.output).toBe(0)
}, 60_000)
