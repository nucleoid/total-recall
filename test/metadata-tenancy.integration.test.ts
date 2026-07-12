import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('metadata tenancy isolation contract', () => {
  it('scopes agents, traces, audit, media, rollup, and RLS to the authenticated key', () => {
    const agents = read('src/agents.ts');
    assert.match(agents, /AuthContext/, 'agent helpers must require auth context');
    assert.match(agents, /a\.api_key_id::text = \$1/, 'ordinary agent list must scope agents by key id');
    assert.match(agents, /auth\.permissions\.includes\('admin'\)/, 'agent list must expose an explicit admin global path');
    assert.match(agents, /m\.client_id = \$1/, 'agent memory counts must scope memories by key id');
    assert.match(agents, /m\.namespace = ANY\(\$2\)/, 'agent memory counts must respect authorized namespaces');

    const traces = read('src/traces.ts');
    assert.match(traces, /rt\.client_id = \$1/, 'ordinary trace list/get must scope rows by key id');
    assert.match(traces, /auth\.permissions\.includes\('admin'\)/, 'trace list/get must expose an explicit admin global path');
    assert.match(traces, /a\.api_key_id::text = rt\.client_id/, 'trace agent joins must stay within the same key');

    const server = read('src/server.ts');
    assert.match(server, /checkPermission\(auth, 'read'\)/, 'GET routes must check read permission');
    assert.match(server, /checkPermission\(auth, 'write'\)/, 'write routes must check write permission');
    assert.match(server, /permissionDenied/, 'permission failures must map to 403');

    const media = read('src/media.ts');
    assert.match(media, /client_id = \$1/, 'media lists and pending selection must scope by key id');
    assert.match(media, /auth\.permissions\.includes\('admin'\)/, 'media event list must expose an explicit admin global path');
    assert.match(media, /WHERE id = \$2 AND client_id = \$3/, 'media linking must not update by event id alone');

    const rollup = read('src/rollup.ts');
    assert.match(rollup, /auth: AuthContext/, 'rollup must run for the authenticated key');
    assert.match(rollup, /checkPermission\(auth, 'write'\)/, 'rollup must require write permission');

    const migrationPath = 'migrations/014_metadata_rls.sql';
    assert.equal(existsSync(join(root, migrationPath)), true, 'metadata RLS migration must exist');
    const migration = read(migrationPath);
    for (const table of ['agents', 'recall_traces', 'audit_log', 'media_events']) {
      assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`), `${table} must enable RLS`);
    }
    for (const policy of ['agents_key_select', 'recall_traces_key_select', 'audit_log_key_select', 'media_events_key_select']) {
      assert.match(migration, new RegExp(`DROP POLICY IF EXISTS ${policy}`), `${policy} must be retry-safe`);
    }
    assert.match(migration, /app_current_key_id\(\)/, 'RLS must fail closed through the metadata key helper');
    assert.match(migration, /app_current_key_is_admin\(\)/, 'RLS must carry explicit admin observability through transaction-local context');
    assert.doesNotMatch(migration, /current_setting\('app\.api_key_id', true\)/, 'stopped-writer rollout must not keep rolling old-writer fallback');
  });

  it('guards review-identified concurrency and validation regressions', () => {
    const db = read('src/db.ts');
    assert.match(db, /DbScope/, 'db context must be explicit per authenticated operation');
    assert.match(db, /set_config\('app\.current_key_id'/, 'metadata RLS key must be set transaction-locally');
    assert.match(db, /set_config\('app\.current_key_is_admin'/, 'metadata RLS admin flag must be set transaction-locally');
    assert.doesNotMatch(db, /AsyncLocalStorage/, 'db context must not use ambient process/session state');

    const traces = read('src/traces.ts');
    assert.doesNotMatch(traces, /rt\.client_id::uuid/, 'trace joins must not cast text client_id to uuid');
    assert.match(traces, /a\.api_key_id::text = rt\.client_id/, 'trace joins should cast uuid side to text');

    const audit = read('src/audit.ts');
    assert.doesNotMatch(audit, /al\.client_id::uuid/, 'audit joins must not cast text client_id to uuid');
    assert.match(audit, /a\.api_key_id::text = al\.client_id/, 'audit joins should cast uuid side to text');

    const media = read('src/media.ts');
    assert.match(media, /rowCount !== 1/, 'media event linking must fail when ownership predicate updates no rows');

    const server = read('src/server.ts');
    assert.match(server, /parseSingleString\(req\.query\.session_id, 'session_id'\)/, 'trace session_id filter must be scalar-validated');
  });

  it('fails fast when media connector rollout keys cannot write to the media namespace', () => {
    const scriptPath = 'scripts/preflight-media-keys.ts';
    assert.equal(existsSync(join(root, scriptPath)), true, 'deployment preflight script must exist');
    const script = read(scriptPath);
    assert.match(script, /preflightMediaConnectorKeys/, 'preflight script must verify configured media connector keys');

    const attribution = read('src/connectors/attribution.ts');
    assert.match(attribution, /preflightMediaConnectorKeys/, 'connector attribution must expose the deployment preflight');
    assert.match(attribution, /const \[keyName\] = mediaConnectorKeyNames\(\)/, 'preflight and runtime must resolve connector keys from the same config source');
    assert.match(attribution, /must include the media namespace/, 'preflight must fail without the media namespace');
    assert.match(attribution, /must include write permission/, 'preflight must fail without write permission');

    const pkg = read('package.json');
    assert.match(pkg, /"preflight:media-keys"/, 'package scripts must expose the media-key deployment preflight');
  });
});
