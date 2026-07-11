import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCESS_LEVELS,
  accessLevelSql,
  canAccessLevel,
  ensureAccessLevelAllowed,
  isAccessLevel,
} from '../src/auth.js';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function assertIncludes(path: string, expected: string): void {
  assert.ok(
    read(path).includes(expected),
    `${path} should include ${JSON.stringify(expected)}`
  );
}

assert.deepEqual(ACCESS_LEVELS, ['normal', 'sensitive', 'secret']);
assert.equal(isAccessLevel('normal'), true);
assert.equal(isAccessLevel('sensitive'), true);
assert.equal(isAccessLevel('secret'), true);
assert.equal(isAccessLevel('private'), false);
assert.equal(isAccessLevel(null), false);

assert.equal(canAccessLevel('normal', 'normal'), true);
assert.equal(canAccessLevel('sensitive', 'normal'), false);
assert.equal(canAccessLevel('secret', 'sensitive'), false);
assert.equal(canAccessLevel('sensitive', 'secret'), true);
assert.equal(canAccessLevel(null, 'normal'), true);
assert.equal(canAccessLevel('unknown', 'secret'), false);

assert.doesNotThrow(() => ensureAccessLevelAllowed('sensitive', 'secret'));
assert.throws(
  () => ensureAccessLevelAllowed('secret', 'sensitive'),
  /Access level denied: requires 'secret', key allows 'sensitive'/
);

const predicate = accessLevelSql('m.access_level', '$3');
assert.match(predicate, /COALESCE\(m\.access_level, 'normal'\)/);
assert.match(predicate, /ELSE 3/);
assert.match(predicate, /ELSE -1/);

assertIncludes('src/search.ts', 'accessLevelSql');
assertIncludes('src/search.ts', 'maxAccessLevel');
assertIncludes('src/tools/search.ts', 'auth.maxAccessLevel');
assertIncludes('src/tools/media-search.ts', 'auth.maxAccessLevel');
assertIncludes('src/tools/recall.ts', 'accessLevelSql');
assertIncludes('src/tools/list.ts', 'accessLevelSql');
assertIncludes('src/tools/list-namespaces.ts', 'accessLevelSql');
assertIncludes('src/tools/stats.ts', 'accessLevelSql');
assertIncludes('src/agents.ts', 'accessLevelSql');
assertIncludes('src/tools/register.ts', 'listAgents(auth, scope)');
assertIncludes('src/server.ts', 'listAgents(auth, dbScopeFromAuth(auth))');
assertIncludes('src/tools/store.ts', 'ensureAccessLevelAllowed');
assertIncludes('src/tools/store-document.ts', "'normal'");

assertIncludes('migrations/009_api_key_access_ceiling.sql', 'max_access_level');
assertIncludes('migrations/009_api_key_access_ceiling.sql', "DEFAULT 'normal'");
assertIncludes('migrations/009_api_key_access_ceiling.sql', "SET max_access_level = 'secret'");
assertIncludes('migrations/009_api_key_access_ceiling.sql', "COALESCE(access_level, 'normal')");
assertIncludes('migrations/009_api_key_access_ceiling.sql', 'NOT VALID');
assertIncludes('migrations/009_api_key_access_ceiling.sql', 'RAISE NOTICE');

assertIncludes('scripts/create-key.ts', '--max-access-level');
assertIncludes('scripts/create-key.ts', "maxAccessLevel = 'normal'");
assertIncludes('README.md', 'max_access_level');
assertIncludes('SPEC.md', 'max_access_level');

console.log('access-level integration checks passed');
