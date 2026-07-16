import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const outdir = resolve(root, 'dist', 'dashboard');
const result = await build({
  absWorkingDir: root,
  entryPoints: ['dashboard/app.ts'],
  outdir,
  entryNames: 'assets/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: 'external',
  metafile: true,
  write: true,
});

const jsOutput = Object.entries(result.metafile.outputs).find(([, output]) => output.entryPoint?.replaceAll('\\', '/') === 'dashboard/app.ts');
if (!jsOutput) throw new Error('Dashboard JavaScript output was not emitted');
const cssOutput = jsOutput[1].cssBundle;
if (!cssOutput) throw new Error('Dashboard CSS output was not emitted');

const template = await readFile(resolve(root, 'dashboard', 'index.html'), 'utf8');
const html = template
  .replace('__APP_JS__', `/dashboard/assets/${basename(jsOutput[0])}`)
  .replace('__APP_CSS__', `/dashboard/assets/${basename(cssOutput)}`);
await writeFile(resolve(outdir, 'index.html'), html);
