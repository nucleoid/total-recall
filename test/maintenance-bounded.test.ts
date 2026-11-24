import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { deriveCalibratedBase, validateCalibrationManifest } from '../scripts/repair-relevance-scores.js';
import { parseDecayCli } from '../scripts/decay-update.js';
import { updateDecayBatchWithClient, validateBoundedDecayOptions } from '../src/maintenance.js';

const facts = { id:'00000000-0000-4000-8000-000000000001', namespace:'personal',
  relevance_score:1.2, decay_rate:0.01, accessed_at:new Date('2026-11-24T00:00:00Z'),
  access_count:2, updated_at:new Date('2026-11-24T00:00:00Z') };

test('calibration derives a nonnegative base preserving the fixed-instant effective score', () => {
  const value=deriveCalibratedBase(facts,'2026-11-24T00:00:00Z');
  assert.ok(value.derivedBaseScore !== null && Math.abs(value.derivedBaseScore-1)<1e-12);
  assert.equal(value.preservedEffectiveScore,1.2); assert.equal(value.rejectionReason,undefined);
  const unsafe=deriveCalibratedBase({...facts,relevance_score:0.1,access_count:2},'2026-11-24T00:00:00Z');
  assert.equal(unsafe.rejectionReason,'effective_score_below_access_bonus');
});

test('calibration manifests are exact, backup-gated, and bounded', () => {
  const approval={id:facts.id,fingerprint:'a'.repeat(64),derivedBaseScore:1,preservedEffectiveScore:1.2};
  assert.throws(()=>validateCalibrationManifest({version:1,backupVerified:false,backupEvidenceReference:'backup/test',asOf:'2026-11-24T00:00:00Z',approvals:[approval]}),/backup/i);
  assert.throws(()=>validateCalibrationManifest({version:1,backupVerified:true,backupEvidenceReference:'backup/test',asOf:'2026-11-24T00:00:00Z',approvals:[approval,approval]}),/Duplicate/);
});

test('bounded decay requires fixed time, bounded page, and explicit apply', async () => {
  assert.deepEqual(parseDecayCli(['--as-of','2026-11-24T00:00:00Z','--limit','10','--after',facts.id,'--dry-run']),
    {asOf:'2026-11-24T00:00:00Z',afterId:facts.id,limit:10,apply:false});
  assert.throws(()=>validateBoundedDecayOptions({asOf:'bad',limit:1,apply:false}),/as-of/);
  assert.throws(()=>validateBoundedDecayOptions({asOf:'2026-11-24T00:00:00Z',limit:1001,apply:false}),/1000/);
  let sql=''; const client={query:async (text:string)=>{sql=text;return {rows:[]};}};
  const result=await updateDecayBatchWithClient(client,{asOf:'2026-11-24T00:00:00Z',limit:1,apply:false});
  assert.equal(result.dryRun,true); assert.doesNotMatch(sql,/DELETE FROM/); assert.doesNotMatch(sql,/UPDATE public\.memories/);
  assert.match(sql,/ORDER BY id LIMIT \$3/); assert.match(sql,/relevance_base_score IS NOT NULL/);
});

test('default decay CLI does not invoke physical TTL purge', async () => {
  const source=await readFile(new URL('../scripts/decay-update.ts',import.meta.url),'utf8');
  const main=source.slice(source.indexOf('async function main'));
  assert.doesNotMatch(main,/purgeExpiredMemories\s*\(/);
  assert.match(main,/updateDecayBatchWithClient/);
});
