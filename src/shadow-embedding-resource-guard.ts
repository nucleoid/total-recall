import { readFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import { cpus, hostname, platform } from 'node:os';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from './local-embedding-contract.js';
import type { VerifiedLocalRuntime } from './local-embedding-client.js';
import { createPinnedTlsFetch } from './local-embedding-transport.js';

export interface ShadowHostPlan {
  deploymentProfile: 'linux-worker' | 'linux-transient-laptop';
  expectedHostname: string;
  diskPath: string;
  minAvailableMemoryBytes: number;
  minAvailableDiskBytes: number;
  maxLoadPerCpu: number;
  maxSwapUsedBytes: number;
  maxMemoryPsiAvg10: number;
  maxCpuPsiAvg10: number;
}

export interface ShadowResourceGuardOptions {
  plan: ShadowHostPlan;
  runtime: VerifiedLocalRuntime;
  baseUrl: string;
  bearerToken: string;
  expectedRuntimeHost: string;
  expectedRuntimeMode: 'gpu' | 'cpu';
  fetch?: typeof fetch;
  readText?: (path: string) => Promise<string>;
  diskAvailable?: (path: string) => Promise<number>;
  host?: () => { platform: string; hostname: string; cpus: number };
}

function finite(value: unknown, code: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw new Error(code);
  return value;
}

export function validateShadowHostPlan(value: unknown, maxElapsedMs: number, maxParents: number): ShadowHostPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('embedding.host_plan');
  const plan = value as ShadowHostPlan;
  const fields = ['deploymentProfile','expectedHostname','diskPath','minAvailableMemoryBytes','minAvailableDiskBytes',
    'maxLoadPerCpu','maxSwapUsedBytes','maxMemoryPsiAvg10','maxCpuPsiAvg10'];
  if (Object.keys(plan).length !== fields.length || Object.keys(plan).some(key => !fields.includes(key))) throw new Error('embedding.host_plan');
  if (!['linux-worker','linux-transient-laptop'].includes(plan.deploymentProfile)
    || !plan.expectedHostname?.trim() || plan.expectedHostname !== plan.expectedHostname.trim()
    || !plan.diskPath?.startsWith('/')) throw new Error('embedding.host_plan');
  finite(plan.minAvailableMemoryBytes, 'embedding.host_plan', 256 * 1024 * 1024);
  finite(plan.minAvailableDiskBytes, 'embedding.host_plan', 1024 * 1024 * 1024);
  finite(plan.maxLoadPerCpu, 'embedding.host_plan', 0.01);
  finite(plan.maxSwapUsedBytes, 'embedding.host_plan');
  finite(plan.maxMemoryPsiAvg10, 'embedding.host_plan');
  finite(plan.maxCpuPsiAvg10, 'embedding.host_plan');
  if (plan.maxMemoryPsiAvg10 > 100 || plan.maxCpuPsiAvg10 > 100) throw new Error('embedding.host_plan');
  if (plan.deploymentProfile === 'linux-transient-laptop' && (maxElapsedMs > 900_000 || maxParents > 100)) {
    throw new Error('embedding.transient_laptop_bounds');
  }
  return plan;
}

function meminfo(text: string) {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_]+):\s+(\d+)\s+kB$/u.exec(line.trim());
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  const available = values.get('MemAvailable'), totalSwap = values.get('SwapTotal'), freeSwap = values.get('SwapFree');
  if (![available,totalSwap,freeSwap].every(Number.isFinite)) throw new Error('embedding.host_metrics_unknown');
  return { availableMemoryBytes: available!, swapUsedBytes: totalSwap! - freeSwap! };
}

function psi(text: string): number {
  const match = /^some\s+avg10=([0-9.]+)/mu.exec(text);
  if (!match) throw new Error('embedding.host_metrics_unknown');
  return finite(Number(match[1]), 'embedding.host_metrics_unknown');
}

export function createShadowResourceGuard(options: ShadowResourceGuardOptions): () => Promise<void> {
  const readText = options.readText ?? (path => readFile(path, 'utf8'));
  const diskAvailable = options.diskAvailable ?? (async path => { const value = await statfs(path); return Number(value.bavail) * Number(value.bsize); });
  const host = options.host ?? (() => ({ platform: platform(), hostname: hostname(), cpus: cpus().length }));
  const url = new URL(options.baseUrl);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('embedding.endpoint');
  if(url.protocol==='https:'&&!options.runtime.tls)throw new Error('embedding.tls_identity');
  if(url.protocol==='http:'&&options.runtime.tls)throw new Error('embedding.tls_unexpected');
  const fetcher=options.fetch??(options.runtime.tls?createPinnedTlsFetch(options.runtime.tls):fetch);
  if (!options.bearerToken.trim() || /[\r\n]/u.test(options.bearerToken)) throw new Error('embedding.credential');
  if (!options.expectedRuntimeHost.trim() || options.expectedRuntimeHost !== options.expectedRuntimeHost.trim()
    || !['gpu','cpu'].includes(options.expectedRuntimeMode)) throw new Error('embedding.runtime_host_plan');
  return async () => {
    const identity = host();
    if (identity.platform !== 'linux' || identity.hostname !== options.plan.expectedHostname || !Number.isSafeInteger(identity.cpus) || identity.cpus < 1) {
      throw new Error('embedding.host_identity');
    }
    let memoryText: string, loadText: string, memoryPsi: string, cpuPsi: string, availableDisk: number;
    try { [memoryText, loadText, memoryPsi, cpuPsi, availableDisk] = await Promise.all([
      readText('/proc/meminfo'), readText('/proc/loadavg'), readText('/proc/pressure/memory'), readText('/proc/pressure/cpu'),
      diskAvailable(options.plan.diskPath),
    ]); } catch { throw new Error('embedding.host_metrics_unknown'); }
    const memory = meminfo(memoryText);
    const load = Number(loadText.trim().split(/\s+/u)[0]);
    if (!Number.isFinite(load)) throw new Error('embedding.host_metrics_unknown');
    if (memory.availableMemoryBytes < options.plan.minAvailableMemoryBytes || availableDisk < options.plan.minAvailableDiskBytes
      || memory.swapUsedBytes > options.plan.maxSwapUsedBytes || load / identity.cpus > options.plan.maxLoadPerCpu
      || psi(memoryPsi) > options.plan.maxMemoryPsiAvg10 || psi(cpuPsi) > options.plan.maxCpuPsiAvg10) {
      throw new Error('embedding.resource_guard');
    }
    let response: Response;
    try { response = await fetcher(new URL('/health', url).toString(), { headers: { Authorization: `Bearer ${options.bearerToken}` }, signal: AbortSignal.timeout(5000), redirect: 'error' }); }
    catch { throw new Error('embedding.runtime_health'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error('embedding.runtime_health'); }
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error('embedding.runtime_health'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('embedding.runtime_health');
    const value = body as Record<string, unknown>;
    if (value.status !== 'ok' || value.contractId !== QWEN_CONTRACT_ID
      || value.artifactSha256 !== QWEN_CHUNK_CONTRACT.artifactSha256
      || value.runtimeContract !== QWEN_CHUNK_CONTRACT.runtimeContract
      || value.acceptanceReceiptSha256 !== options.runtime.acceptanceReceiptSha256
      || value.verifiedLaunch !== true || value.hostId !== options.expectedRuntimeHost
      || !value.telemetry || typeof value.telemetry !== 'object' || Array.isArray(value.telemetry)) throw new Error('embedding.runtime_health');
    const telemetry = value.telemetry as Record<string, unknown>;
    if (telemetry.hostId !== options.expectedRuntimeHost || telemetry.mode !== options.expectedRuntimeMode
      || typeof telemetry.timestamp !== 'number' || !Number.isFinite(telemetry.timestamp)
      || Math.abs(Date.now() - telemetry.timestamp) > 5_000) throw new Error('embedding.runtime_health');
    if (options.expectedRuntimeMode === 'gpu') {
      const temperature = finite(telemetry.gpuTempC, 'embedding.runtime_health');
      const used = finite(telemetry.vramUsedMiB, 'embedding.runtime_health');
      const total = finite(telemetry.vramTotalMiB, 'embedding.runtime_health', Number.MIN_VALUE);
      if (temperature >= 85 || used > total) throw new Error('embedding.runtime_health');
    } else {
      finite(telemetry.availableBytes, 'embedding.runtime_health');
      finite(telemetry.swapUsedBytes, 'embedding.runtime_health');
      finite(telemetry.memoryPsiAvg10, 'embedding.runtime_health');
    }
  };
}
