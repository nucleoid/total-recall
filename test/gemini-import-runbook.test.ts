import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Gemini import and repair commands/configuration are documented fail-closed', async () => {
  const [pkgText, env, readme, scriptsConfig] = await Promise.all([
    read('package.json'), read('.env.example'), read('README.md'), read('tsconfig.scripts.json'),
  ]);
  const pkg = JSON.parse(pkgText);
  assert.equal(pkg.scripts['repair:gemini-source-keys'], 'tsx scripts/repair-gemini-source-keys.ts');
  assert.match(env, /GEMINI_TAKEOUT_HTML_PATH/);
  assert.match(readme, /gemini-conv:v2:<sha256>/i);
  assert.match(readme, /NZST[\s\S]*NZDT[\s\S]*(UTC|numeric offset)/i);
  assert.match(readme, /preview[\s\S]*restorable backup[\s\S]*independently verify[\s\S]*approval manifest/i);
  assert.match(readme, /MIGRATION_DATABASE_URL/);
  assert.match(readme, /4,?000[\s\S]*(indistinguishable|cannot distinguish)/i);
  assert.match(scriptsConfig, /preseed-gemini/);
  assert.match(scriptsConfig, /repair-gemini-source-keys/);
});
