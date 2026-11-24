import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  deriveCalibratedBase, deriveFloorExceptionCandidate, validateCalibrationManifest,
  validateFloorExceptionIds, validateFloorExceptionManifest,
} from '../scripts/repair-relevance-scores.js';
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
  assert.match(sql,/expires_at > statement_timestamp\(\)/);
  assert.match(sql,/valid_from <= statement_timestamp\(\)/);
});

test('default decay CLI does not invoke physical TTL purge', async () => {
  const source=await readFile(new URL('../scripts/decay-update.ts',import.meta.url),'utf8');
  const main=source.slice(source.indexOf('async function main'));
  assert.doesNotMatch(main,/purgeExpiredMemories\s*\(/);
  assert.match(main,/updateDecayBatchWithClient/);
});


test('floor exceptions require exact reviewed IDs and only raise a score to its earned capped bonus', () => {
  const row = {
    id: facts.id, namespace: 'personal', access_level: 'secret', client_id: 'legacy-owner', source: 'synthetic',
    memory_kind: 'semantic', content_hash: 'b'.repeat(32), relevance_score: 0.987, relevance_base_score: null,
    decay_rate: 0.01, accessed_at: new Date('2026-11-24T00:00:00Z'), access_count: 63,
    updated_at: new Date('2026-11-24T00:00:00Z'), expires_at: null, valid_from: new Date('2026-01-01T00:00:00Z'),
    valid_to: null, deleted_at: null, superseded_at: null, consolidated_into_id: null,
    dispatched_at: new Date('2026-11-24T12:00:00Z'),
  };
  const candidate = deriveFloorExceptionCandidate(row);
  assert.equal(candidate.rejectionReason, undefined);
  assert.equal(candidate.currentScore, 0.987);
  assert.equal(candidate.earnedBonus, 1);
  assert.equal(candidate.proposedBaseScore, 0);
  assert.equal(candidate.proposedScore, 1);
  assert.deepEqual(validateFloorExceptionIds({ ids: [facts.id] }), [facts.id]);
  assert.throws(() => validateFloorExceptionIds([facts.id, facts.id]), /duplicate/i);
  const approval = { ...candidate, currentScore: candidate.currentScore!, earnedBonus: candidate.earnedBonus!,
    proposedScore: candidate.proposedScore! };
  delete (approval as { namespace?: string }).namespace;
  delete (approval as { accessLevel?: string }).accessLevel;
  const manifest = validateFloorExceptionManifest({
    version: 1, kind: 'access_bonus_floor_exception', operatorApproved: true,
    operatorReviewReference: 'review/71-exceptions', backupVerified: true,
    backupEvidenceReference: 'backup/verified-before-floor-repair', approvals: [approval],
  });
  assert.equal(manifest.approvals[0].proposedScore, 1);
  assert.throws(() => validateFloorExceptionManifest({ ...manifest, operatorApproved: false as true }), /operator-approved/i);
  assert.equal(deriveFloorExceptionCandidate({ ...row, expires_at: new Date('2026-11-24T11:59:59Z') }).rejectionReason,
    'memory_expired_at_dispatch');
  assert.equal(deriveFloorExceptionCandidate({ ...row, access_count: Number.POSITIVE_INFINITY }).rejectionReason,
    'access_count_not_finite');
});
