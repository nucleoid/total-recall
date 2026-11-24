import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { tasteProfileLockIdentity } from '../scripts/taste-profile.js';

test('taste-profile advisory lock identity is stable PostgreSQL text without tuple ambiguity', () => {
  const identity = tasteProfileLockIdentity(
    '11111111-1111-4111-8111-111111111111',
    'production',
  );

  assert.equal(identity, '["11111111-1111-4111-8111-111111111111","production"]');
  assert.equal(identity.includes('\0'), false);
  assert.deepEqual(JSON.parse(identity), [
    '11111111-1111-4111-8111-111111111111',
    'production',
  ]);
  assert.notEqual(
    tasteProfileLockIdentity('key', 'environment-a'),
    tasteProfileLockIdentity('key-environment', 'a'),
  );
});

const databaseUrl = process.env.TASTE_PROFILE_TEST_DATABASE_URL;

test('PostgreSQL accepts the taste-profile identity for hashtext advisory locking', {
  skip: !databaseUrl,
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  const identity = tasteProfileLockIdentity(
    '11111111-1111-4111-8111-111111111111',
    'integration-test',
  );
  const lockClass = 0x54525450;
  await client.connect();
  try {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked',
      [lockClass, identity],
    );
    assert.equal(locked.rows[0]?.locked, true);
    const unlocked = await client.query<{ unlocked: boolean }>(
      'SELECT pg_advisory_unlock($1, hashtext($2)) AS unlocked',
      [lockClass, identity],
    );
    assert.equal(unlocked.rows[0]?.unlocked, true);
  } finally {
    await client.end();
  }
});
