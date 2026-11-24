import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const outdir = resolve(root, 'dist', 'connector-runtime');
await rm(outdir, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: {
    spotify: 'scripts/spotify-sync.ts',
    ytmusic: 'scripts/ytmusic-sync.ts',
    plex: 'scripts/plex-sync.ts',
    browser: 'scripts/browser-history-sync.ts',
  },
  outdir,
  bundle: true,
  packages: 'external',
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  minify: false,
  write: true,
});
