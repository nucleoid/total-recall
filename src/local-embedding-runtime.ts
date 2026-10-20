import { LocalEmbeddingClient, type VerifiedLocalRuntime } from './local-embedding-client.js';
import { QWEN_CONTRACT_ID } from './local-embedding-contract.js';

type LocalServingEnvironment = {
  SHADOW_EMBEDDING_CURRENT_CONTRACT?: string;
  SHADOW_EMBEDDING_URL?: string;
  SHADOW_EMBEDDING_API_KEY?: string;
  SHADOW_EMBEDDING_RUNTIME_JSON?: string;
};

let injectedClient: LocalEmbeddingClient | undefined;
let configuredClient: LocalEmbeddingClient | undefined;

/** An absent target preserves the established Gemini serving path. Unknown targets fail closed. */
export function localServingEnabled(env: LocalServingEnvironment = process.env): boolean {
  const target = env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  if (target === undefined || target === '') return false;
  if (target !== target.trim() || target !== QWEN_CONTRACT_ID) {
    throw new Error('shadow_embedding.unknown_serving_contract');
  }
  return true;
}

/** Construct the identity-verified local client only when the Qwen contract is explicitly active. */
export function getLocalServingClient(env: LocalServingEnvironment = process.env): LocalEmbeddingClient {
  if (!localServingEnabled(env)) throw new Error('shadow_embedding.local_serving_disabled');
  if (injectedClient) return injectedClient;
  if (env === process.env && configuredClient) return configuredClient;

  const baseUrl = required(env.SHADOW_EMBEDDING_URL, 'shadow_embedding.url');
  const bearerToken = required(env.SHADOW_EMBEDDING_API_KEY, 'shadow_embedding.credential');
  const runtime = parseRuntime(env.SHADOW_EMBEDDING_RUNTIME_JSON);
  const client = new LocalEmbeddingClient({
    baseUrl,
    bearerToken,
    runtime,
    // Serving is request bounded. Host-level admission/thermal gating remains part of
    // the accepted runtime represented by the immutable receipt.
    beforeInference: async () => {},
  });
  if (env === process.env) configuredClient = client;
  return client;
}

/** Test-only injection avoids environment credentials and network access. */
export function setLocalServingClientForTesting(client: LocalEmbeddingClient | undefined): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('shadow_embedding.test_injection_forbidden');
  injectedClient = client;
  configuredClient = undefined;
}

function required(value: string | undefined, code: string): string {
  if (!value?.trim() || value !== value.trim()) throw new Error(code);
  return value;
}

function parseRuntime(raw: string | undefined): VerifiedLocalRuntime {
  if (!raw) throw new Error('shadow_embedding.runtime_missing');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('shadow_embedding.runtime_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shadow_embedding.runtime_shape');
  const record = value as Record<string, unknown>;
  const fields = ['contractId', 'artifactSha256', 'runtimeContract', 'acceptanceReceiptSha256'];
  if (!fields.every(field => typeof record[field] === 'string') || Object.keys(record).some(field => ![...fields,'tls'].includes(field))) {
    throw new Error('shadow_embedding.runtime_shape');
  }
  if(record.tls!==undefined){if(!record.tls||typeof record.tls!=='object'||Array.isArray(record.tls))throw new Error('shadow_embedding.runtime_shape');
    const tls=record.tls as Record<string,unknown>,tlsFields=['caPath','caSha256','spkiSha256'];
    if(Object.keys(tls).length!==tlsFields.length||tlsFields.some(field=>typeof tls[field]!=='string'))throw new Error('shadow_embedding.runtime_shape');}
  return record as unknown as VerifiedLocalRuntime;
}
