import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { build } from 'vite'
import { isolateGitEnvironment } from './helpers/git-environment'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desktop-asar-scan-'))
const scanner = path.join(directory, 'turn-files.cjs')
const runner = path.join(directory, 'runner.cjs')

// A real, small ASAR: Electron's fs can parse it and retain its archive handle.
function archive(): Buffer {
  const data = Buffer.from('original\n')
  const json = Buffer.from(JSON.stringify({ files: { 'entry.txt': { size: data.length, offset: '0' } } }))
  const payloadSize = 4 + json.length
  const padding = (4 - payloadSize % 4) % 4
  const headerSize = 4 + payloadSize + padding
  const header = Buffer.alloc(8 + headerSize)
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(headerSize, 4)
  header.writeUInt32LE(payloadSize + padding, 8)
  header.writeUInt32LE(json.length, 12)
  json.copy(header, 16)
  return Buffer.concat([header, data])
}

beforeAll(async () => {
  await build({ configFile: false, publicDir: false, logLevel: 'silent',
    resolve: { alias: { '@shared': path.resolve('src/shared') } },
    build: { target: 'node22', outDir: directory, emptyOutDir: false,
      lib: { entry: path.resolve('src/main/turn-files.ts'), formats: ['cjs'], fileName: () => 'turn-files.cjs' },
      rollupOptions: { external: (id) => id.startsWith('node:') || builtinModules.includes(id) || id === 'original-fs' }
    }
  })
  fs.writeFileSync(runner, `
const {app} = require('electron');
const assert = require('node:assert/strict');
const fs = require('original-fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {snapshotTurnFiles, changedTurnFiles} = require(${JSON.stringify(scanner)});
const root = process.argv[2], mode = process.argv[3];
app.setPath('userData', path.join(root, '..', 'profile-' + mode));
app.whenReady().then(async () => {
  const project = mode === 'container' ? path.join(root, 'code') : root;
  fs.mkdirSync(project, {recursive:true});
  if (mode !== 'directory') execFileSync('git', ['init', '-q'], {cwd:project, windowsHide:true});
  const resourceDir = path.join(root, 'resources');
  fs.mkdirSync(resourceDir);
  const archive = path.join(resourceDir, 'app.asar');
  const raw = fs.readFileSync(path.join(root, '..', 'fixture.asar'));
  fs.writeFileSync(archive, raw);
  const large = path.join(resourceDir, 'oversized.asar');
  const largeRaw = Buffer.concat([raw, Buffer.alloc(257 * 1024)]);
  fs.writeFileSync(large, largeRaw);
  fs.writeFileSync(path.join(project, 'source.txt'), 'before\\n');
  const before = await snapshotTurnFiles(root);
  // Replacement happens while the scanner's Electron process is still alive.
  // Before the fix this fails with Windows error 5 due to the cached ASAR handle.
  const replace = (file, data) => {
    fs.writeFileSync(file + '.replacement', data);
    fs.renameSync(file + '.replacement', file);
  };
  replace(archive, Buffer.concat([raw, Buffer.from('updated')]));
  replace(large, largeRaw);
  assert.ok(before.some(snapshot => [...snapshot.files].some(([name,data]) =>
    name.replaceAll('\\\\','/') === 'resources/app.asar' && data.equals(raw))));
  fs.writeFileSync(path.join(project, 'source.txt'), 'after\\n');
  // Also exercise files first discovered by the post-turn scan.
  const added = path.join(resourceDir, 'added.asar');
  fs.writeFileSync(added, raw);
  const changes = await changedTurnFiles(before);
  const relative = changes.map(file => path.relative(root,file.path).replaceAll('\\\\','/')).sort();
  assert.deepEqual(relative, ['resources/added.asar','resources/app.asar',mode === 'container' ? 'code/source.txt' : 'source.txt'].sort());
  replace(archive, raw);
  replace(added, raw);
  replace(large, largeRaw);
  fs.writeFileSync(path.join(root, '..', 'result-' + mode + '.json'), JSON.stringify({ok:true}));
  app.quit();
}).catch(error => {console.error(error);app.exit(1);});
`)
  fs.writeFileSync(path.join(directory, 'fixture.asar'), archive())
})

afterAll(() => {
  vi.unstubAllEnvs()
  const resolved = path.resolve(directory)
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agent-desktop-asar-scan-')) throw new Error('Unexpected test directory')
  fs.rmSync(resolved, { recursive: true, force: true })
})

it.runIf(process.platform === 'win32').each(['directory', 'git', 'container'])(
  'keeps ASAR files replaceable after real Electron snapshots in a %s project', async (mode) => {
    const root = path.join(directory, mode)
    fs.mkdirSync(root)
    isolateGitEnvironment(root)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const electron = createRequire(import.meta.url)('electron') as string
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(electron, [runner, root, mode], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('Electron scan timed out: ' + output)) }, 15_000)
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { output += chunk })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); resolve({ code, output }) })
    })
    expect(result.code, result.output).toBe(0)
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'result-' + mode + '.json'), 'utf8'))).toEqual({ ok: true })
  }, 20_000
)
