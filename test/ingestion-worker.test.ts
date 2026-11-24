import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyIngestionFailure, embedWithinBudget, inlineBudgetMs } from '../src/ingestion.js';
import { EmbeddingProviderError, EmbeddingValidationError, ACTIVE_EMBEDDING_PROFILE } from '../src/embedding.js';
import { parseIngestionWorkerCli } from '../scripts/ingestion-worker.js';
import { retryAtForAttempt } from '../src/retry.js';

test('ingestion classifies HTTP, invalid vectors and transport errors without retaining error messages', () => {
  for (const [status, category, terminal] of [[429,'rate_limited',false],[500,'transient',false],[408,'transient',false],
    [425,'transient',false],[401,'provider_auth',false],[403,'provider_auth',false],[400,'input_rejected',true],
    [404,'input_rejected',true],[413,'input_rejected',true],[422,'input_rejected',true]] as const) {
    const result = classifyIngestionFailure(new EmbeddingProviderError(status,'123'));
    assert.equal(result.category,category); assert.equal(result.terminal,terminal); assert.equal(result.retryAfter,'123');
  }
  assert.equal(classifyIngestionFailure(new EmbeddingValidationError('private vector')).terminal,true);
  for (const error of [new DOMException('private','TimeoutError'),new DOMException('private','AbortError'),
    Object.assign(new Error('private DNS'),{code:'ENOTFOUND'}),Object.assign(new Error('private'),{code:'ECONNREFUSED'})]) {
    assert.equal(classifyIngestionFailure(error).category,'transient');
    assert.doesNotMatch(JSON.stringify(classifyIngestionFailure(error)),/private/);
  }
});
test('published local chunks can be rehydrated without an inference call and incomplete sets fail closed', async () => {
  const originalContract=process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  try {
    process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT=(await import('../src/local-embedding-contract.js')).QWEN_CONTRACT_ID;
    const { loadPublishedLocalDocument }=await import('../src/local-embedding-consumers.js');
    const { sha256 }=await import('../src/local-embedding-contract.js');
    const text='first paragraph\n\nlast paragraph';
    const source=Buffer.from(text,'utf8'), split=Buffer.byteLength('first paragraph\n\n','utf8');
    const vector=`[1,${Array(767).fill(0).join(',')}]`;
    const rows=[source.subarray(0,split),source.subarray(split)].map((chunk,index) => ({
      source_sha256:sha256(source),source_bytes:source.length,chunk_count:2,ordinal:index,
      core_start:index===0?0:split,core_end:index===0?split:source.length,
      chunk_sha256:sha256(chunk),formatted_tokens:8,embedding:vector,
    }));
    let calls=0;
    const client={ query:async () => { calls++; return { rows }; } };
    const prepared=await loadPublishedLocalDocument(client as any,'00000000-0000-0000-0000-000000000001',text,
      '00000000-0000-0000-0000-000000000002');
    assert.equal(calls,1); assert.equal(prepared?.plan.chunks.length,2);
    assert.deepEqual(prepared?.vectors[0].slice(0,2),[1,0]);
    const incomplete={ query:async () => ({ rows:rows.slice(0,1) }) };
    assert.equal(await loadPublishedLocalDocument(incomplete as any,'00000000-0000-0000-0000-000000000001',text,
      '00000000-0000-0000-0000-000000000002'),undefined);
  } finally {
    if(originalContract===undefined) delete process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
    else process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT=originalContract;
  }
});
test('database contention has a content-free code distinct from provider failures', () => {
  for (const code of ['55P03','57014','40P01','40001']) {
    const failure = classifyIngestionFailure(Object.assign(new Error('private SQL content'), { code }));
    assert.deepEqual(failure, { category:'transient', code:'db_contention', terminal:false });
  }
});

test('retry curve has positive bounded jitter, honors Retry-After and reaches twelve-hour cap', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  for (const [attempt,seconds] of [[1,60],[2,300],[3,1800],[4,7200],[5,43200],[12,43200]]) {
    const delay = (retryAtForAttempt(attempt,undefined,now).getTime()-now.getTime())/1000;
    assert.ok(delay>=seconds && delay<=Math.min(43200,seconds*1.2));
  }
  assert.ok(retryAtForAttempt(1,'600',now).getTime() >= now.getTime()+600000);
  assert.ok(retryAtForAttempt(1,'Thu, 01 Jan 2026 00:10:00 GMT',now).getTime() >= now.getTime()+600000);
});
test('inline budget bounds providers ignoring abort; late success cannot finalize', async () => {
  let completed = false;
  const start = Date.now();
  await assert.rejects(embedWithinBudget('never disclose',20,async () => {
    await new Promise(resolve => setTimeout(resolve,100)); completed = true;
    return { vector:Array(768).fill(1),...ACTIVE_EMBEDDING_PROFILE };
  }),/budget exhausted/);
  assert.ok(Date.now()-start<95); assert.equal(completed,false);
});
test('worker CLI validates bounded concurrency and rejects missing values', () => {
  assert.deepEqual(parseIngestionWorkerCli(['--once','--max-jobs','5','--poll-ms','200','--concurrency','2']),{ once:true,maxJobs:5,pollMs:200,concurrency:2,batchSize:16 });
  assert.equal(parseIngestionWorkerCli(['--batch-size','64']).batchSize,64);
  for (const value of ['','0','65','1.5']) assert.throws(() => parseIngestionWorkerCli(['--batch-size',value]));
  for (const args of [['--concurrency','33'],['--concurrency'],['--max-jobs','0'],['--poll-ms','1'],['--wat']]) assert.throws(() => parseIngestionWorkerCli(args));
  const old = process.env.MEMORY_STORE_INLINE_EMBED_MS;
  try { process.env.MEMORY_STORE_INLINE_EMBED_MS=''; assert.throws(inlineBudgetMs); process.env.MEMORY_STORE_INLINE_EMBED_MS='0'; assert.equal(inlineBudgetMs(),0); }
  finally { if (old === undefined) delete process.env.MEMORY_STORE_INLINE_EMBED_MS; else process.env.MEMORY_STORE_INLINE_EMBED_MS=old; }
});

test('worker startup rejects invalid dedupe thresholds before claims', () => {
  for (const value of ['', 'abc', '-1', '1.01']) {
    const result = spawnSync(process.execPath, ['--import','./test/setup-embedding-env.mjs','--import','tsx',
      '--input-type=module','--eval',"await import('./scripts/ingestion-worker.ts')"], {
      cwd: process.cwd(), encoding:'utf8', env:{ ...process.env, MEMORY_DEDUPE_THRESHOLD:value },
    });
    assert.notEqual(result.status,0); assert.match(result.stderr,/MEMORY_DEDUPE_THRESHOLD/);
  }
});

test('worker leases cover the configured embedding plus approved classifier deadlines', async () => {
  const {workerIngestionLeaseMs}=await import('../src/ingestion.js');
  const {contradictionPolicyFromEnv}=await import('../src/contradictions.js');
  const old=process.env.EMBEDDING_TIMEOUT_MS;
  try { process.env.EMBEDDING_TIMEOUT_MS='120000';
    const policy={...contradictionPolicyFromEnv(),mutationEnabled:true,timeoutMs:60000};
    assert.ok(workerIngestionLeaseMs(policy)>=120000+policy.timeoutMs+30000);
  } finally { if(old===undefined) delete process.env.EMBEDDING_TIMEOUT_MS; else process.env.EMBEDDING_TIMEOUT_MS=old; }
});
