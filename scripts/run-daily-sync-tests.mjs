#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform !== 'linux') {
  console.log('SKIP daily-sync integration tests require Linux with /proc, flock, and python3');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('bash', ['test/daily-sync.test.sh'], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`daily-sync integration tests could not start Bash: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`daily-sync integration tests terminated by signal ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
