import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowResourceGuard, validateShadowHostPlan } from '../src/shadow-embedding-resource-guard.js';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import {LocalEmbeddingError} from '../src/local-embedding-client.js';

const plan = () => ({ deploymentProfile: 'linux-worker' as const, expectedHostname: 'worker-1', diskPath: '/srv',
  minAvailableMemoryBytes: 1024 ** 3, minAvailableDiskBytes: 10 * 1024 ** 3, maxLoadPerCpu: 1,
  maxSwapUsedBytes: 128 * 1024 ** 2, maxMemoryPsiAvg10: 1, maxCpuPsiAvg10: 5 });
const runtime = { contractId: QWEN_CONTRACT_ID, artifactSha256: QWEN_CHUNK_CONTRACT.artifactSha256,
  runtimeContract: QWEN_CHUNK_CONTRACT.runtimeContract, acceptanceReceiptSha256: 'a'.repeat(64),
  tls:{caPath:'/approved/ca.pem',caSha256:'b'.repeat(64),spkiSha256:'c'.repeat(64)} };
const telemetry = () => ({ hostId: 'gpu-1', timestamp: Date.now(), mode: 'gpu', gpuTempC: 60, vramUsedMiB: 1024, vramTotalMiB: 8192 });
const files: Record<string, string> = {
  '/proc/meminfo': 'MemAvailable: 4194304 kB\nSwapTotal: 1048576 kB\nSwapFree: 1048576 kB\n',
  '/proc/loadavg': '0.50 0.25 0.10 1/100 1\n', '/proc/pressure/memory': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
  '/proc/pressure/cpu': 'some avg10=0.25 avg60=0.10 avg300=0.05 total=1\n',
};

test('host plan makes laptop execution explicit and tightly finite', () => {
  assert.equal(validateShadowHostPlan(plan(), 60_000, 20).deploymentProfile, 'linux-worker');
  assert.throws(() => validateShadowHostPlan({ ...plan(), deploymentProfile: 'linux-transient-laptop' }, 901_000, 20), /transient_laptop_bounds/);
  assert.throws(() => validateShadowHostPlan({ ...plan(), deploymentProfile: 'linux-transient-laptop' }, 60_000, 101), /transient_laptop_bounds/);
  assert.throws(() => validateShadowHostPlan({ ...plan(), mystery: true }, 60_000, 20), /host_plan/);
});

test('resource guard verifies Linux identity, bounded host metrics and authenticated pinned runtime health', async () => {
  let authorization: string | null = null;
  const guard = createShadowResourceGuard({ plan: plan(), runtime, baseUrl: 'https://runtime.internal', bearerToken: 'secret',
    expectedRuntimeHost: 'gpu-1', expectedRuntimeMode: 'gpu',
    host: () => ({ platform: 'linux', hostname: 'worker-1', cpus: 4 }), readText: async path => files[path],
    diskAvailable: async () => 20 * 1024 ** 3, fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization');
      return Response.json({ status: 'ok', verifiedLaunch: true, hostId: 'gpu-1', telemetry: telemetry(), ...runtime });
    }) as typeof fetch });
  await guard(); assert.equal(authorization, 'Bearer secret');
});

test('resource guard fails closed for unknown metrics, pressure, host drift and runtime drift', async () => {
  const make = (change: Record<string, unknown> = {}) => createShadowResourceGuard({ plan: plan(), runtime,
    baseUrl: 'https://runtime.internal', bearerToken: 'secret', expectedRuntimeHost: 'gpu-1', expectedRuntimeMode: 'gpu',
    host: () => ({ platform: 'linux', hostname: 'worker-1', cpus: 4 }),
    readText: async path => files[path], diskAvailable: async () => 20 * 1024 ** 3,
    fetch: (async () => Response.json({ status: 'ok', verifiedLaunch: true, hostId: 'gpu-1', telemetry: telemetry(), ...runtime })) as typeof fetch, ...change });
  await assert.rejects(make({ host: () => ({ platform: 'win32', hostname: 'worker-1', cpus: 4 }) }), /host_identity/);
  await assert.rejects(make({ readText: async () => 'unknown' }), /host_metrics_unknown/);
  await assert.rejects(make({ diskAvailable: async () => 1 }), /resource_guard/);
  await assert.rejects(make({ fetch: (async () => Response.json({ status: 'ok', verifiedLaunch: true, hostId: 'gpu-1', telemetry: telemetry(), ...runtime, contractId: 'wrong' })) as typeof fetch }), /runtime_health/);
  await assert.rejects(make({ fetch: (async () => Response.json({ status: 'ok', verifiedLaunch: true, hostId: 'gpu-1',
    telemetry: { ...telemetry(), timestamp: Date.now() - 5_001 }, ...runtime })) as typeof fetch }), /runtime_health/);
  await assert.rejects(make({ fetch: (async () => Response.json({ status: 'ok', verifiedLaunch: true, hostId: 'gpu-1',
    telemetry: { ...telemetry(), gpuTempC: 85 }, ...runtime })) as typeof fetch }), /runtime_health/);
});

test('resource guard accepts fresh bounded CPU gateway telemetry', async () => {
  const guard = createShadowResourceGuard({ plan: plan(), runtime, baseUrl: 'https://runtime.internal', bearerToken: 'secret',
    expectedRuntimeHost: 'cpu-1', expectedRuntimeMode: 'cpu',
    host: () => ({ platform: 'linux', hostname: 'worker-1', cpus: 4 }), readText: async path => files[path],
    diskAvailable: async () => 20 * 1024 ** 3, fetch: (async () => Response.json({ status: 'ok', verifiedLaunch: true,
      hostId: 'cpu-1', telemetry: { hostId: 'cpu-1', timestamp: Date.now(), mode: 'cpu', availableBytes: 4 * 1024 ** 3,
        swapUsedBytes: 0, memoryPsiAvg10: 0 }, ...runtime })) as typeof fetch });
  await guard();
});

test('resource guard distinguishes only the exact bounded gateway busy response',async()=>{
  const make=(response:Response)=>createShadowResourceGuard({plan:plan(),runtime,baseUrl:'https://runtime.internal',bearerToken:'secret',
    expectedRuntimeHost:'gpu-1',expectedRuntimeMode:'gpu',host:()=>({platform:'linux',hostname:'worker-1',cpus:4}),
    readText:async path=>files[path],diskAvailable:async()=>20*1024**3,fetch:(async()=>response) as typeof fetch});
  await assert.rejects(make(Response.json({error:'busy'},{status:429})),error=>error instanceof LocalEmbeddingError&&error.code==='embedding.gateway_busy');
  for(const body of [{error:'busy',extra:true},{error:'other'}])await assert.rejects(make(Response.json(body,{status:429})),/runtime_health/);
  await assert.rejects(make(new Response('not json',{status:429})),/runtime_health/);
  await assert.rejects(make(Response.json({error:'busy'},{status:503})),/runtime_health/);
});
