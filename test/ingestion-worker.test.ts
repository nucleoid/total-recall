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
  assert.deepEqual(parseIngestionWorkerCli(['--once','--max-jobs','5','--poll-ms','200','--concurrency','2']),{ once:true,maxJobs:5,pollMs:200,concurrency:2 });
  for (const args of [['--concurrency','33'],['--concurrency'],['--max-jobs','0'],['--poll-ms','1'],['--wat']]) assert.throws(() => parseIngestionWorkerCli(args));
  const old = process.env.MEMORY_STORE_INLINE_EMBED_MS;
  try { process.env.MEMORY_STORE_INLINE_EMBED_MS=''; assert.throws(inlineBudgetMs); process.env.MEMORY_STORE_INLINE_EMBED_MS='0'; assert.equal(inlineBudgetMs(),0); }
  finally { if (old === undefined) delete process.env.MEMORY_STORE_INLINE_EMBED_MS; else process.env.MEMORY_STORE_INLINE_EMBED_MS=old; }
});
