import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { LocalEmbeddingClient, type VerifiedLocalRuntime } from '../src/local-embedding-client.js';
import { OpenRouterEmbeddingClient } from '../src/openrouter-embedding-client.js';
import { compatibilityAccepted, compatibilityMetrics, OPENROUTER_LOCAL_THRESHOLDS } from '../src/embedding-compatibility.js';
import { QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';

// Public, invented inputs only; never send personal facts as compatibility fixtures.
const documents = [
  'The p\u014dhutukawa is a coastal tree native to Aotearoa New Zealand.',
  'PostgreSQL advisory locks coordinate application work without changing rows.',
  'Ethereum validators attest to beacon-chain state and may propose blocks.',
  'A fictional orange cat called Pixel travelled from Canada to New Zealand.',
  'Unicode fixture: caf\u00e9, \u65e5\u672c\u8a9e, \u0645\u0631\u062d\u0628\u0627, \ud83c\udf0a.',
  'Long fixture: ' + 'bounded retrieval context '.repeat(60),
];
const queries = [
  'Which tree is native to coastal New Zealand?',
  'How can PostgreSQL coordinate work without row updates?',
  'What does an Ethereum validator do?',
  'Where did the fictional orange cat travel from?',
  'Find the multilingual Unicode passage.',
];

function runtimeEnvironment(): { baseUrl: string; bearerToken: string; runtime: VerifiedLocalRuntime } {
  const baseUrl = process.env.SHADOW_EMBEDDING_URL;
  const bearerToken = process.env.SHADOW_EMBEDDING_API_KEY;
  const raw = process.env.SHADOW_EMBEDDING_RUNTIME_JSON;
  if (!baseUrl?.trim() || !bearerToken?.trim() || !raw) throw new Error('embedding.worker_runtime_environment');
  const runtime = JSON.parse(raw) as VerifiedLocalRuntime;
  if (runtime.contractId !== QWEN_CONTRACT_ID) throw new Error('embedding.runtime_identity');
  return { baseUrl, bearerToken, runtime };
}

async function batches<T>(values: string[], embed: (batch: string[]) => Promise<T[]>): Promise<T[]> {
  const output: T[] = [];
  for (let index = 0; index < values.length; index += 4) output.push(...await embed(values.slice(index, index + 4)));
  return output;
}

async function main() {
  const key = process.env.OPENROUTER_API_KEY;
  const receiptPath = process.env.COMPATIBILITY_RECEIPT_PATH;
  if (!key?.trim() || /[\r\n]/u.test(key)) throw new Error('embedding.openrouter_credential_required');
  if (!receiptPath?.trim()) throw new Error('embedding.compatibility_receipt_path');
  const local = new LocalEmbeddingClient({ ...runtimeEnvironment(), beforeInference: async () => {} });
  const hosted = new OpenRouterEmbeddingClient({
    apiKey: key,
    countFormattedTokens: local.countFormattedTokens.bind(local),
    beforeInference: async () => {},
  });
  const localDocuments = await batches(documents, async batch => (await local.embed(batch, 'document')).vectors);
  const hostedDocuments = await batches(documents, async batch => (await hosted.embed(batch, 'document')).vectors);
  const localQueries = await batches(queries, async batch => (await local.embed(batch, 'query')).vectors);
  const hostedQueries = await batches(queries, async batch => (await hosted.embed(batch, 'query')).vectors);
  const metrics = compatibilityMetrics(hostedDocuments, localDocuments, hostedQueries, localQueries);
  const accepted = compatibilityAccepted(metrics);
  const receipt = {
    schema: 1,
    status: accepted ? 'pass' : 'fail',
    scope: 'fixed-public-synthetic-fixtures-only',
    contractId: QWEN_CONTRACT_ID,
    fixtureSha256: createHash('sha256').update(JSON.stringify({ documents, queries })).digest('hex'),
    thresholds: OPENROUTER_LOCAL_THRESHOLDS,
    metrics,
    hosted: { model: 'qwen/qwen3-embedding-4b', provider: 'DeepInfra', fallback: false },
    local: { runtime: runtimeEnvironment().runtime.runtimeContract, artifactSha256: runtimeEnvironment().runtime.artifactSha256 },
    completedAt: new Date().toISOString(),
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: receipt.status, fixtureSha256: receipt.fixtureSha256, metrics }));
  if (!accepted) process.exitCode = 2;
}

main().catch(error => {
  console.error(error instanceof Error && /^embedding\./u.test(error.message) ? error.message : 'embedding.compatibility_failed');
  process.exitCode = 1;
});
