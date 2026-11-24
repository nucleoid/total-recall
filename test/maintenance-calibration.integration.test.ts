import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { loadMigrationInventory, runMigrations } from '../scripts/migrate.js';
import { provisionDatabase } from '../scripts/provision-db.js';
import {
  applyCalibrationBatch, applyFloorExceptionBatch, finalizeCalibratedRelevanceBase,
  previewCalibrationBatch, previewFloorExceptionBatch, rollbackFloorExceptionBatch,
  type FloorExceptionManifest,
} from '../scripts/repair-relevance-scores.js';
import { updateDecayBatchWithClient } from '../src/maintenance.js';

const asOf='2026-11-24T00:00:00.000Z';
const calibratedId='00000000-0000-4000-8000-000000000001';
const driftId='00000000-0000-4000-8000-000000000002';
const decayId='00000000-0000-4000-8000-000000000003';
const floorId='10000000-0000-4000-8000-000000000001';
const floorDriftId='10000000-0000-4000-8000-000000000002';
const expiredId='10000000-0000-4000-8000-000000000003';
const expiredDecayId='20000000-0000-4000-8000-000000000001';

test('bounded calibration preserves score, rejects drift, replays, and feeds bounded decay', {timeout:240000}, async t => {
  const port=await new Promise<number>((resolve,reject)=>{const server=createServer();server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{const value=(server.address() as {port:number}).port;server.close(error=>error?reject(error):resolve(value));});});
  const container=execFileSync('docker',['run','--rm','-d','-e','POSTGRES_PASSWORD=test-only','-p',`127.0.0.1:${port}:5432`,process.env.POSTGRES_TEST_IMAGE||'pgvector/pgvector:pg16'],{encoding:'utf8'}).trim();
  let owner:pg.Client|undefined;
  t.after(async()=>{if(owner)await owner.end();try{execFileSync('docker',['rm','-f',container],{stdio:'ignore'});}catch{}});
  const url=`postgresql://postgres:test-only@127.0.0.1:${port}/postgres`;
  for(let index=0;index<150;index++){const candidate=new pg.Client({connectionString:url,connectionTimeoutMillis:2000});
    try{await candidate.connect();owner=candidate;break;}catch{await candidate.end();await new Promise(resolve=>setTimeout(resolve,200));}}
  assert.ok(owner); await owner.query('CREATE EXTENSION vector');
  await provisionDatabase(owner,{appPassword:'app-test-only',rotateAppPassword:false});
  await runMigrations(owner,loadMigrationInventory(fileURLToPath(new URL('../migrations',import.meta.url))),{lockTimeoutMs:5000});
  for(const [id,score,count] of [[calibratedId,1.2,2],[driftId,1.1,1],[decayId,0,2]] as const){
    await owner.query(`INSERT INTO memories(id,content,source,namespace,access_level,client_id,memory_kind,valid_from,
      relevance_score,relevance_base_score,decay_rate,accessed_at,access_count)
      VALUES($1,'synthetic maintenance fact','synthetic','personal','normal','maintenance-test','semantic',$2,
        $3,$4,0.01,$2,$5)`,[id,asOf,score,id===decayId?1:null,count]);
  }
  for (const [id,score,count,expires] of [
    [floorId,0.987,63,null], [floorDriftId,0.95,10,null], [expiredId,0.9,10,'2026-11-24T00:00:01.000Z'],
  ] as const) {
    await owner.query(`INSERT INTO memories(id,content,source,namespace,access_level,client_id,memory_kind,valid_from,
      relevance_score,relevance_base_score,decay_rate,accessed_at,access_count,expires_at)
      VALUES($1,'synthetic floor exception fact','synthetic','financial','secret','legacy-non-uuid-owner','semantic',$2,
        $3,NULL,0.01,$2,$4,$5)`,[id,asOf,score,count,expires]);
  }

  await owner.query(`INSERT INTO memories(id,content,source,namespace,access_level,client_id,memory_kind,valid_from,
    relevance_score,relevance_base_score,decay_rate,accessed_at,access_count,expires_at)
    VALUES($1,'expired decay candidate','synthetic','personal','normal','maintenance-test','semantic',$2,
      1.2,1,0.01,$2,2,'2026-11-24T00:00:01.000Z')`,[expiredDecayId,asOf]);

  const preview=await previewCalibrationBatch(url,asOf,null,10);
  const first=preview.candidates.find(row=>row.id===calibratedId)!;
  const drift=preview.candidates.find(row=>row.id===driftId)!;
  assert.ok(Math.abs(first.derivedBaseScore!-1)<1e-12);
  const manifest={version:1 as const,backupVerified:true,backupEvidenceReference:'backup/test',asOf,approvals:[{id:first.id,fingerprint:first.fingerprint,
    derivedBaseScore:first.derivedBaseScore!,preservedEffectiveScore:first.preservedEffectiveScore!}]};
  const applied=await applyCalibrationBatch(url,manifest); assert.equal(applied.updated,1); assert.equal(applied.finalized,false);
  const stored=await owner.query('SELECT relevance_score,relevance_base_score FROM memories WHERE id=$1',[calibratedId]);
  assert.equal(Number(stored.rows[0].relevance_score),1.2); assert.ok(Math.abs(Number(stored.rows[0].relevance_base_score)-1)<1e-12);
  const replay=await applyCalibrationBatch(url,manifest); assert.equal(replay.updated,0); assert.equal(replay.alreadyApplied,1);

  await owner.query('UPDATE memories SET access_count=access_count+1,updated_at=statement_timestamp() WHERE id=$1',[driftId]);
  await assert.rejects(applyCalibrationBatch(url,{version:1,backupVerified:true,backupEvidenceReference:'backup/test',asOf,approvals:[{id:drift.id,
    fingerprint:drift.fingerprint,derivedBaseScore:drift.derivedBaseScore!,preservedEffectiveScore:drift.preservedEffectiveScore!}]}),/drift/i);
  await assert.rejects(finalizeCalibratedRelevanceBase(url,true),/unclassified/i);

  const calibrationIds=preview.candidates.map(row=>row.id);
  assert.equal(calibrationIds.includes(expiredId),false,'fixed asOf must not re-admit a row expired at dispatch');
  const floorPreview=await previewFloorExceptionBatch(url,{ids:[floorId]});
  const floor=floorPreview.candidates[0];
  assert.equal(floor.rejectionReason,undefined); assert.equal(floor.currentScore,0.987);
  assert.equal(floor.earnedBonus,1); assert.equal(floor.proposedBaseScore,0); assert.equal(floor.proposedScore,1);
  const expiredPreview=await previewFloorExceptionBatch(url,[expiredId]);
  assert.equal(expiredPreview.candidates[0].rejectionReason,'memory_expired_at_dispatch');
  const before=await owner.query(`SELECT content,source,namespace,access_level,client_id,accessed_at,access_count
    FROM memories WHERE id=$1`,[floorId]);
  const floorManifest:FloorExceptionManifest={version:1,kind:'access_bonus_floor_exception',operatorApproved:true,
    operatorReviewReference:'review/test-floor-exception',backupVerified:true,backupEvidenceReference:'backup/test-floor',
    approvals:[{id:floor.id,beforeFingerprint:floor.beforeFingerprint,guardFingerprint:floor.guardFingerprint,
      currentScore:floor.currentScore!,earnedBonus:floor.earnedBonus!,proposedBaseScore:0,proposedScore:floor.proposedScore!}]};
  const floorApplied=await applyFloorExceptionBatch(url,floorManifest);
  assert.equal(floorApplied.updated,1); assert.equal(floorApplied.finalized,false);
  const floorStored=await owner.query(`SELECT content,source,namespace,access_level,client_id,accessed_at,access_count,
    relevance_score,relevance_base_score FROM memories WHERE id=$1`,[floorId]);
  assert.deepEqual(Object.fromEntries(Object.entries(floorStored.rows[0]).filter(([key])=>
    !['relevance_score','relevance_base_score'].includes(key))),before.rows[0]);
  assert.equal(Number(floorStored.rows[0].relevance_base_score),0); assert.equal(Number(floorStored.rows[0].relevance_score),1);
  const floorReplay=await applyFloorExceptionBatch(url,floorManifest);
  assert.equal(floorReplay.updated,0); assert.equal(floorReplay.alreadyApplied,1);
  await assert.rejects(finalizeCalibratedRelevanceBase(url,true),/unclassified/i);

  const driftPreview=(await previewFloorExceptionBatch(url,[floorDriftId])).candidates[0];
  const driftManifest:FloorExceptionManifest={...floorManifest,operatorReviewReference:'review/test-floor-drift',approvals:[{
    id:driftPreview.id,beforeFingerprint:driftPreview.beforeFingerprint,guardFingerprint:driftPreview.guardFingerprint,
    currentScore:driftPreview.currentScore!,earnedBonus:driftPreview.earnedBonus!,proposedBaseScore:0,
    proposedScore:driftPreview.proposedScore!,
  }]};
  await owner.query('UPDATE memories SET access_count=access_count+1,updated_at=statement_timestamp() WHERE id=$1',[floorDriftId]);
  await assert.rejects(applyFloorExceptionBatch(url,driftManifest),/guard drift/i);
  await owner.query("UPDATE memories SET access_count=10,access_level='sensitive',updated_at=statement_timestamp() WHERE id=$1",[floorDriftId]);
  await assert.rejects(applyFloorExceptionBatch(url,driftManifest),/guard drift/i);

  const rolledBack=await rollbackFloorExceptionBatch(url,floorManifest);
  assert.equal(rolledBack.restored,1);
  const restored=await owner.query('SELECT relevance_score,relevance_base_score FROM memories WHERE id=$1',[floorId]);
  assert.equal(Number(restored.rows[0].relevance_score),0.987); assert.equal(restored.rows[0].relevance_base_score,null);
  const rollbackReplay=await rollbackFloorExceptionBatch(url,floorManifest);
  assert.equal(rollbackReplay.restored,0); assert.equal(rollbackReplay.alreadyRestored,1);
  await assert.rejects(finalizeCalibratedRelevanceBase(url,true),/unclassified/i);

  const decay=await updateDecayBatchWithClient(owner,{asOf,afterId:driftId,limit:1,apply:true});
  assert.equal(decay.selected,1); assert.equal(decay.nextCursor,decayId); assert.equal(decay.updated,1);
  const decayed=await owner.query('SELECT relevance_score FROM memories WHERE id=$1',[decayId]);
  assert.equal(Number(decayed.rows[0].relevance_score),1.2);
  const decayReplay=await updateDecayBatchWithClient(owner,{asOf,afterId:driftId,limit:1,apply:true});
  assert.equal(decayReplay.updated,0);
  const next=await updateDecayBatchWithClient(owner,{asOf,afterId:decay.nextCursor,limit:1,apply:false});
  assert.equal(next.selected,0);
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM audit_log WHERE action='relevance_base_calibration'")).rows[0].n,2);
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM audit_log WHERE action='relevance_base_floor_exception'")).rows[0].n,2);
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM audit_log WHERE action='relevance_base_floor_exception_rollback'")).rows[0].n,2);
});
