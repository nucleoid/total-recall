import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { LocalEmbeddingClient } from '../src/local-embedding-client.js';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID, sha256 } from '../src/local-embedding-contract.js';
import { planEmbeddingChunks } from '../src/embedding-chunks.js';

// Synthetic acceptance fixtures; no production URL, credentials or source text.
const bases = ['', ' \t\r\n ', 'A specific name: Rimu Harbour.', 'const f = (x: number) => x * x;',
  '中文检索与记忆。日本語の名前。', 'Kia ora, tēnā koutou. café e\u0301 👩🏽‍💻 🚀',
  'First paragraph.\n\nSecond paragraph.\n\nEnd.', 'Windows\r\n\r\nline endings.',
  'alpha '.repeat(180), '連続文字'.repeat(180)];
const fixtures = Array.from({ length: 50 }, (_, i) => i < 10 ? bases[i] : `${bases[i % 10]}\n\nFixture ${i}: unique retrieval fact ${i * 7919}.`);
const run = promisify(execFile);
async function gpuGuard(): Promise<void> {
  const result = await run('nvidia-smi', ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 3000, windowsHide: true });
  const values = result.stdout.trim().split(/\r?\n/u).map(Number);
  if (!values.length || values.some(n => !Number.isInteger(n) || n < 0 || n >= 85)) throw new Error('runtime.thermal_guard');
}

async function main() {
  const [gpuUrl, cpuUrl, keyFile, outputFile, syntheticReferenceFile] = process.argv.slice(2);
  if (!gpuUrl || !cpuUrl || !keyFile || !outputFile || ![6,7].includes(process.argv.length)) throw new Error('runtime.arguments');
  for (const raw of [gpuUrl, cpuUrl]) {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('runtime.loopback_required');
  }
  const fixtureSha256 = sha256(JSON.stringify(fixtures));
  // A provisional identity permits testing; it is never an acceptance receipt.
  const runtime = { contractId: QWEN_CONTRACT_ID, artifactSha256: QWEN_CHUNK_CONTRACT.artifactSha256,
    runtimeContract: QWEN_CHUNK_CONTRACT.runtimeContract, acceptanceReceiptSha256: fixtureSha256 };
  const bearerToken = (await readFile(keyFile, 'utf8')).trim();
  const gpu = new LocalEmbeddingClient({ baseUrl: gpuUrl, bearerToken, runtime, timeoutMs: 120_000, beforeInference: gpuGuard });
  const cpu = new LocalEmbeddingClient({ baseUrl: cpuUrl, bearerToken, runtime, timeoutMs: 120_000, beforeInference: async () => {} });
  const deadline = AbortSignal.timeout(600_000);
  let minimumCosine = 1, chunks = 0, vectors = 0, tokens = 0;
  const queryMs: number[] = [];
  const parityFailures: Array<{ fixture: number; role: string; chunk?: number; cosine: number }> = [];
  const reference: Array<{text:string;role:'document'|'query';tokens:number;vector:number[]}> = [];
  await gpu.embed(['warmup'], 'query', deadline);
  for (const source of fixtures) {
    const plan = await planEmbeddingChunks(source, text => gpu.countFormattedTokens(text, deadline));
    if (Buffer.concat(plan.chunks.map(c => Buffer.from(c.text))).toString('utf8') !== source) throw new Error('runtime.reconstruction');
    chunks += plan.chunks.length;
    for (let index = 0; index < plan.chunks.length; index += 4) {
      const texts = plan.chunks.slice(index, index + 4).map(c => c.text);
      const actual = await gpu.embed(texts, 'document', deadline), peer = await cpu.embed(texts, 'document', deadline);
      if (JSON.stringify(actual.tokens) !== JSON.stringify(peer.tokens)) throw new Error('runtime.tokenizer_parity');
      for (let i = 0; i < texts.length; i++) {
        reference.push({text:texts[i],role:'document',tokens:actual.tokens[i],vector:actual.vectors[i]});
        const cosine = actual.vectors[i].reduce((sum, n, j) => sum + n * peer.vectors[i][j], 0);
        minimumCosine = Math.min(minimumCosine, cosine);
        if (cosine < 0.999) parityFailures.push({fixture: fixtures.indexOf(source), role: 'document', chunk: index + i, cosine});
      }
      vectors += texts.length; tokens += actual.tokens.reduce((sum, n) => sum + n, 0);
    }
    const query = `Find fixture ${vectors}: ${source.slice(0, 100)}`;
    const started = performance.now();
    const actual = await gpu.embed([query], 'query', deadline);
    queryMs.push(performance.now() - started);
    const peer = await cpu.embed([query], 'query', deadline);
    reference.push({text:query,role:'query',tokens:actual.tokens[0],vector:actual.vectors[0]});
    const cosine = actual.vectors[0].reduce((sum, n, j) => sum + n * peer.vectors[0][j], 0);
    minimumCosine = Math.min(minimumCosine, cosine);
    if (actual.tokens[0] !== peer.tokens[0]) throw new Error('runtime.query_tokenizer_parity');
    if (cosine < 0.999) parityFailures.push({fixture: fixtures.indexOf(source), role: 'query', cosine});
    vectors++; tokens += actual.tokens[0];
  }
  queryMs.sort((a, b) => a - b);
  const cardinalityValid = fixtures.length === 50 && chunks === 107 && vectors === 157 && queryMs.length === 50 && reference.length === 157;
  const receipt = { status: !parityFailures.length && cardinalityValid ? 'pass' : 'fail', scope: 'synthetic-laptop-cpu-gpu-only', contractId: QWEN_CONTRACT_ID,
    fixtureSha256, fixtures: fixtures.length, documentVectors: chunks, queryVectors: queryMs.length, vectors, tokens, minimumCosine,
    parityFailures, gpuWarmQueryP95Ms: queryMs[Math.ceil(queryMs.length * 0.95) - 1], createdAt: new Date().toISOString(),
    limitations: ['Not validator latency or production quality acceptance', 'Artifact and process identity must be recorded by the launch controller'] };
  await writeFile(outputFile, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  if (syntheticReferenceFile && receipt.status === 'pass') await writeFile(syntheticReferenceFile,
    JSON.stringify({scope:'fixed-public-synthetic-fixtures-only',fixtureSha256,contractId:QWEN_CONTRACT_ID,reference})+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(receipt));
  if (receipt.status !== 'pass') process.exitCode = 1;
}
main().catch(error => {
  console.error(error instanceof Error && /^(runtime|embedding)\.[a-z_]+$/u.test(error.message)
    ? error.message : 'runtime.acceptance_failed');
  process.exitCode = 1;
});
