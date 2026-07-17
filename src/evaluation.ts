import { createHash } from 'node:crypto';
import { z } from 'zod';
import { accessLevelSql } from './auth.js';
import { withScopedClient, type DbScope, type ScopedClient } from './db.js';
import {
  ACTIVE_EMBEDDING_PROFILE,
  embedWithProfile,
  type EmbeddingProfile,
} from './embedding.js';
import {
  DEFAULT_SEARCH_RANKING_CONFIG,
  rankMemories,
  validateSearchRankingConfig,
} from './search.js';
import type {
  AccessLevel,
  SearchParams,
  SearchRankingConfig,
  SearchResult,
} from './types.js';

const instant = z.string().datetime({ offset: true });
const identitySchema = z.union([
  z.object({ source_key: z.string().min(1).max(512) }).strict(),
  z.object({ id: z.string().uuid() }).strict(),
]);

export const evaluationFiltersSchema = z.object({
  tags: z.array(z.string().min(1)).max(100).optional(),
  source: z.string().min(1).optional(),
  after: instant.optional(),
  before: instant.optional(),
  valid_at: instant.optional(),
  media: z.object({
    services: z.array(z.string().min(1)).optional(),
    event_types: z.array(z.string().min(1)).optional(),
    event_after: instant.optional(),
    event_before: instant.optional(),
    event_before_exclusive: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export const evaluationCaseSchema = z.object({
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  query: z.string().min(1).max(20_000),
  k: z.number().int().min(1).max(50).optional(),
  threshold: z.number().min(-1).max(1).optional(),
  filters: evaluationFiltersSchema.optional(),
  relevant: z.array(identitySchema).max(100).optional(),
  expect_no_results: z.boolean().optional(),
}).strict();

export const evaluationDatasetSchema = z.object({
  schema_version: z.literal(1),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  identity_mode: z.enum(['source_key', 'local_uuid']).default('source_key'),
  namespaces: z.array(z.string().min(1).max(200)).min(1),
  defaults: z.object({
    k: z.number().int().min(1).max(50).default(10),
    threshold: z.number().min(-1).max(1).default(0.3),
  }).strict().default({ k: 10, threshold: 0.3 }),
  cases: z.array(evaluationCaseSchema).min(1),
}).strict();

export type EvaluationIdentity = z.infer<typeof identitySchema>;
export type EvaluationFilters = z.infer<typeof evaluationFiltersSchema>;
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;
export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>;

export interface CaseMetric {
  recall: number | null;
  reciprocal_rank: number | null;
  hit: boolean | null;
  first_relevant_rank: number | null;
  relevant_count: number;
  retrieved_relevant_count: number;
}

export interface EvaluationDiagnostic {
  id: string;
  source_key: string | null;
  rank: number;
  vec_score: number | null;
  text_score: number;
  diagnostic_base_score: number;
  relevance: number;
  final_score: number;
  relevant: boolean;
  content?: string;
}

export interface EvaluationCaseReport {
  id: string;
  k: number;
  threshold: number;
  expected: string[];
  unresolved: string[];
  warnings: string[];
  returned_count: number;
  top_scores?: number[];
  metric: CaseMetric;
  results: EvaluationDiagnostic[];
}

export interface EvaluationReport {
  report_schema_version: 1;
  created_at: string;
  dataset: { name: string; hash: string; schema_version: 1 };
  code: { commit: string | null };
  embedding: { provider: string; model: string; dimensions: number; profile: string };
  execution: {
    as_of: string;
    database_label: string | null;
    concurrency: number;
    ef_search: number;
    ranking: SearchRankingConfig;
    ranking_hash: string;
    config_hash: string;
    access_tracking: false;
  };
  metrics: { recall_at_k: number; mrr: number; hit_rate_at_k: number; evaluated_cases: number; diagnostic_cases: number };
  warnings: string[];
  cases: EvaluationCaseReport[];
}

export interface EvaluationRunOptions {
  scope: DbScope;
  maxAccessLevel: AccessLevel;
  asOf?: string;
  ranking?: SearchRankingConfig;
  k?: number;
  threshold?: number;
  allowUnresolved?: boolean;
  checkOnly?: boolean;
  showContent?: boolean;
  codeCommit?: string | null;
  efSearch: number;
  databaseLabel?: string;
  concurrency?: number;
  embed?: (query: string, profile: EmbeddingProfile) => Promise<{ vector: number[] }>;
  search?: typeof rankMemories;
}

const rankingReportSchema = z.object({
  vectorWeight: z.number().finite().nonnegative(),
  textWeight: z.number().finite().nonnegative(),
  diagnosticTextMatchBonus: z.number().finite().nonnegative(),
  finalTextMatchBonus: z.number().finite().nonnegative(),
  relevanceCap: z.number().finite().positive(),
  vectorCandidateLimit: z.number().int().min(1).max(1000),
  textCandidateLimit: z.number().int().min(1).max(1000),
  resultLimitCap: z.number().int().min(1).max(1000),
}).strict();
const metricReportSchema = z.object({
  recall: z.number().min(0).max(1).nullable(), reciprocal_rank: z.number().min(0).max(1).nullable(),
  hit: z.boolean().nullable(), first_relevant_rank: z.number().int().positive().nullable(),
  relevant_count: z.number().int().nonnegative(), retrieved_relevant_count: z.number().int().nonnegative(),
}).strict();

/** Strict reader contract for persisted baselines and reports. */
export const evaluationReportSchema = z.object({
  report_schema_version: z.literal(1), created_at: instant,
  dataset: z.object({ name: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/), schema_version: z.literal(1) }).strict(),
  code: z.object({ commit: z.string().nullable() }).strict(),
  embedding: z.object({ provider: z.string(), model: z.string(), dimensions: z.number().int().positive(), profile: z.string() }).strict(),
  execution: z.object({
    as_of: instant, database_label: z.string().min(1).nullable(), concurrency: z.number().int().min(1).max(32),
    ef_search: z.number().int().min(1).max(1000),
    ranking: rankingReportSchema, ranking_hash: z.string().regex(/^[a-f0-9]{64}$/),
    config_hash: z.string().regex(/^[a-f0-9]{64}$/), access_tracking: z.literal(false),
  }).strict(),
  metrics: z.object({
    recall_at_k: z.number().min(0).max(1), mrr: z.number().min(0).max(1), hit_rate_at_k: z.number().min(0).max(1),
    evaluated_cases: z.number().int().nonnegative(), diagnostic_cases: z.number().int().nonnegative(),
  }).strict(),
  warnings: z.array(z.string()),
  cases: z.array(z.object({
    id: z.string(), k: z.number().int().positive(), threshold: z.number().min(-1).max(1),
    expected: z.array(z.string()), unresolved: z.array(z.string()), warnings: z.array(z.string()),
    returned_count: z.number().int().nonnegative(), top_scores: z.array(z.number().finite()).optional(), metric: metricReportSchema,
    results: z.array(z.object({
      id: z.string(), source_key: z.string().nullable(), rank: z.number().int().positive(),
      vec_score: z.number().finite().nullable(), text_score: z.number().finite(), diagnostic_base_score: z.number().finite(),
      relevance: z.number().finite(), final_score: z.number().finite(), relevant: z.boolean(), content: z.string().optional(),
    }).strict()),
  }).strict()),
}).strict();

export function parseEvaluationDataset(input: unknown): EvaluationDataset {
  const dataset = evaluationDatasetSchema.parse(input);
  const caseIds = new Set<string>();
  for (const item of dataset.cases) {
    if (caseIds.has(item.id)) throw new Error(`Duplicate evaluation case id: ${item.id}`);
    caseIds.add(item.id);
    const relevant = item.relevant ?? [];
    if (item.expect_no_results === true) {
      if (relevant.length) throw new Error(`Case ${item.id} cannot combine expect_no_results with relevant identities`);
    } else if (!relevant.length) {
      throw new Error(`Case ${item.id} requires relevant identities or expect_no_results=true`);
    }
    const identities = new Set<string>();
    for (const identity of relevant) {
      if ('id' in identity && dataset.identity_mode !== 'local_uuid') {
        throw new Error(`Case ${item.id} uses a UUID but dataset identity_mode is not local_uuid`);
      }
      const key = identityKey(identity);
      if (identities.has(key)) throw new Error(`Case ${item.id} repeats judgment ${displayIdentity(identity)}`);
      identities.add(key);
    }
  }
  return dataset;
}

export function caseMetric(
  relevantIds: ReadonlySet<string>,
  resultIds: readonly string[],
  k: number,
  diagnosticOnly = false,
  judgedRelevantCount = relevantIds.size,
): CaseMetric {
  if (!Number.isSafeInteger(k) || k < 1) throw new Error('k must be a positive integer');
  if (new Set(resultIds).size !== resultIds.length) throw new Error('Retrieved result IDs must be unique');
  if (diagnosticOnly) {
    return { recall: null, reciprocal_rank: null, hit: null, first_relevant_rank: null, relevant_count: 0, retrieved_relevant_count: 0 };
  }
  if (!Number.isSafeInteger(judgedRelevantCount) || judgedRelevantCount < relevantIds.size || judgedRelevantCount < 1) {
    throw new Error('A scored case must have at least one judged relevant identity');
  }
  const top = resultIds.slice(0, k);
  const ranks = top.flatMap((id, index) => relevantIds.has(id) ? [index + 1] : []);
  return {
    recall: ranks.length / judgedRelevantCount,
    reciprocal_rank: ranks.length ? 1 / ranks[0] : 0,
    hit: ranks.length > 0,
    first_relevant_rank: ranks[0] ?? null,
    relevant_count: judgedRelevantCount,
    retrieved_relevant_count: ranks.length,
  };
}

export function aggregateMetrics(metrics: readonly CaseMetric[]): EvaluationReport['metrics'] {
  const scored = metrics.filter((metric): metric is CaseMetric & { recall: number; reciprocal_rank: number; hit: boolean } =>
    metric.recall !== null && metric.reciprocal_rank !== null && metric.hit !== null);
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return {
    recall_at_k: mean(scored.map(metric => metric.recall)),
    mrr: mean(scored.map(metric => metric.reciprocal_rank)),
    hit_rate_at_k: mean(scored.map(metric => metric.hit ? 1 : 0)),
    evaluated_cases: scored.length,
    diagnostic_cases: metrics.length - scored.length,
  };
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function baselineMismatches(current: EvaluationReport, baseline: EvaluationReport): string[] {
  const mismatches: string[] = [];
  if (current.report_schema_version !== baseline.report_schema_version) mismatches.push('report schema major');
  if (current.dataset.hash !== baseline.dataset.hash) mismatches.push('dataset hash');
  if (current.execution.ranking_hash !== baseline.execution.ranking_hash) mismatches.push('ranking config');
  if (current.execution.config_hash !== baseline.execution.config_hash) mismatches.push('query/filter/k/threshold config');
  if (current.execution.as_of !== baseline.execution.as_of) mismatches.push('as_of');
  if (current.execution.database_label !== baseline.execution.database_label) mismatches.push('database label');
  if (current.execution.ef_search !== baseline.execution.ef_search) mismatches.push('ef_search');
  for (const field of ['provider', 'model', 'dimensions'] as const) {
    if (current.embedding[field] !== baseline.embedding[field]) mismatches.push(`embedding ${field}`);
  }
  return mismatches;
}

export async function runEvaluation(datasetInput: unknown, options: EvaluationRunOptions): Promise<EvaluationReport> {
  const dataset = parseEvaluationDataset(datasetInput);
  if (!dataset.namespaces.every(namespace => options.scope.namespaces.includes(namespace))) {
    throw new Error('Dataset namespaces exceed the evaluation credential scope');
  }
  const ranking = validateSearchRankingConfig(options.ranking ?? DEFAULT_SEARCH_RANKING_CONFIG);
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Evaluation concurrency must be an integer from 1 to 32');
  const asOf = normalizeInstant(options.asOf ?? new Date().toISOString());
  const resolved = await resolveDataset(dataset, options.scope, options.maxAccessLevel);
  const unresolvedCount = resolved.reduce((sum, item) => sum + item.unresolved.length, 0);
  if (unresolvedCount && !options.allowUnresolved) {
    throw new Error(`${unresolvedCount} expected identities were unresolved in scope`);
  }

  const configForHash = {
    concurrency,
    cases: dataset.cases.map(item => ({
      id: item.id,
      k: options.k ?? item.k ?? dataset.defaults.k,
      threshold: options.threshold ?? item.threshold ?? dataset.defaults.threshold,
      filters: item.filters ?? {},
    })),
  };
  const report: EvaluationReport = {
    report_schema_version: 1,
    created_at: new Date().toISOString(),
    dataset: { name: dataset.name, hash: stableHash(dataset), schema_version: 1 },
    code: { commit: options.codeCommit ?? null },
    embedding: {
      provider: ACTIVE_EMBEDDING_PROFILE.provider,
      model: ACTIVE_EMBEDDING_PROFILE.model,
      dimensions: ACTIVE_EMBEDDING_PROFILE.dimensions,
      profile: ACTIVE_EMBEDDING_PROFILE.name,
    },
    execution: {
      as_of: asOf,
      database_label: options.databaseLabel?.trim() || null,
      concurrency,
      ef_search: options.efSearch,
      ranking,
      ranking_hash: stableHash(ranking),
      config_hash: stableHash(configForHash),
      access_tracking: false,
    },
    metrics: { recall_at_k: 0, mrr: 0, hit_rate_at_k: 0, evaluated_cases: 0, diagnostic_cases: 0 },
    warnings: [
      'Embedding descriptors describe the active process; they do not prove compatibility of every stored row.',
      ...(unresolvedCount ? [`${unresolvedCount} expected identities were unresolved and treated as misses.`] : []),
    ],
    cases: [],
  };

  if (options.checkOnly) return report;
  const embed = options.embed ?? embedWithProfile;
  const search = options.search ?? rankMemories;
  const caseReports = new Array<EvaluationCaseReport>(dataset.cases.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < dataset.cases.length) {
      const index = nextIndex++;
      const item = dataset.cases[index];
      const identityResolution = resolved[index];
      const k = options.k ?? item.k ?? dataset.defaults.k;
      const threshold = options.threshold ?? item.threshold ?? dataset.defaults.threshold;
      const embedding = await embed(item.query, ACTIVE_EMBEDDING_PROFILE);
      const results = await search(
        toSearchParams(item, k, threshold),
        dataset.namespaces,
        options.scope,
        options.maxAccessLevel,
        {
          asOf,
          ranking,
          queryVectors: [{ profile: ACTIVE_EMBEDDING_PROFILE, vector: embedding.vector }],
        },
      );
      assertFiniteResults(results, item.id);
      const relevantIds = new Set(identityResolution.ids);
      const metric = caseMetric(
        relevantIds,
        results.map(result => result.id),
        k,
        item.expect_no_results === true,
        item.relevant?.length ?? 0,
      );
      caseReports[index] = {
        id: item.id,
        k,
        threshold,
        expected: identityResolution.labels,
        unresolved: identityResolution.unresolved,
        warnings: identityResolution.warnings,
        returned_count: results.length,
        ...(item.expect_no_results ? { top_scores: results.slice(0, k).map(result => result.final_score) } : {}),
        metric,
        results: results.slice(0, k).map((result, resultIndex) => diagnostic(result, resultIndex, relevantIds, options.showContent === true)),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, dataset.cases.length) }, worker));
  report.cases = caseReports;
  report.metrics = aggregateMetrics(report.cases.map(item => item.metric));
  return report;
}

interface Resolution { ids: string[]; labels: string[]; unresolved: string[]; warnings: string[] }

async function resolveDataset(dataset: EvaluationDataset, scope: DbScope, maxAccessLevel: AccessLevel): Promise<Resolution[]> {
  return withScopedClient(scope, async client => {
    const output: Resolution[] = [];
    for (const item of dataset.cases) output.push(await resolveCase(client, item, dataset.namespaces, maxAccessLevel));
    return output;
  }, { readOnly: true });
}

async function resolveCase(client: ScopedClient, item: EvaluationCase, namespaces: string[], maxAccessLevel: AccessLevel): Promise<Resolution> {
  const identities = item.relevant ?? [];
  if (!identities.length) return { ids: [], labels: [], unresolved: [], warnings: [] };
  const sourceKeys = identities.flatMap(identity => 'source_key' in identity ? [identity.source_key] : []);
  const ids = identities.flatMap(identity => 'id' in identity ? [identity.id] : []);
  const values: unknown[] = [namespaces, maxAccessLevel, sourceKeys, ids];
  const conditions = [
    'namespace = ANY($1)', accessLevelSql('access_level', '$2'),
    'deleted_at IS NULL', '(expires_at IS NULL OR expires_at > statement_timestamp())',
    '(source_key = ANY($3::text[]) OR id = ANY($4::uuid[]))',
  ];
  const filter = item.filters;
  const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (filter?.tags?.length) conditions.push(`tags @> ${add(filter.tags)}`);
  if (filter?.source) conditions.push(`source = ${add(filter.source)}`);
  if (filter?.after) conditions.push(`created_at >= ${add(filter.after)}::timestamptz`);
  if (filter?.before) conditions.push(`created_at <= ${add(filter.before)}::timestamptz`);
  if (filter?.valid_at) {
    const validAt = add(filter.valid_at);
    conditions.push(`valid_from <= ${validAt}::timestamptz`);
    conditions.push(`(valid_to IS NULL OR ${validAt}::timestamptz < valid_to)`);
  }
  if (filter?.media?.services?.length) conditions.push(`metadata->>'service' = ANY(${add(filter.media.services)}::text[])`);
  if (filter?.media?.event_types?.length) conditions.push(`metadata->>'event_type' = ANY(${add(filter.media.event_types)}::text[])`);
  if (filter?.media?.event_after) conditions.push(`event_at >= ${add(filter.media.event_after)}::timestamptz`);
  if (filter?.media?.event_before) conditions.push(`event_at ${filter.media.event_before_exclusive ? '<' : '<='} ${add(filter.media.event_before)}::timestamptz`);
  const result = await client.query<{ id: string; source_key: string | null }>(
    `SELECT id, source_key FROM memories WHERE ${conditions.join(' AND ')}`,
    values,
  );
  const byId = new Map(result.rows.map(row => [row.id, row]));
  const byKey = new Map<string, { id: string; source_key: string | null }>();
  const ambiguousKeys = new Set<string>();
  for (const row of result.rows) {
    if (row.source_key === null) continue;
    if (byKey.has(row.source_key)) ambiguousKeys.add(row.source_key);
    else byKey.set(row.source_key, row);
  }
  if (ambiguousKeys.size) {
    throw new Error(`Case ${item.id} has source_key judgments that are not unique in authorized scope; use a local UUID or a unique source key`);
  }
  const resolution: Resolution = { ids: [], labels: [], unresolved: [], warnings: [] };
  for (const identity of identities) {
    const row = 'source_key' in identity ? byKey.get(identity.source_key) : byId.get(identity.id);
    const label = displayIdentity(identity);
    resolution.labels.push(label);
    if (!row) resolution.unresolved.push(label);
    else resolution.ids.push(row.id);
    if ('id' in identity) resolution.warnings.push(`Case ${item.id} uses local UUID ${truncateUuid(identity.id)}; source_key is preferred.`);
  }
  if (new Set(resolution.ids).size !== resolution.ids.length) {
    throw new Error(`Case ${item.id} judges the same memory through more than one identity`);
  }
  return resolution;
}

function toSearchParams(item: EvaluationCase, k: number, threshold: number): SearchParams {
  const filter = item.filters;
  return {
    query: item.query, limit: k, threshold,
    tags: filter?.tags, source: filter?.source, after: filter?.after, before: filter?.before, valid_at: filter?.valid_at,
    mediaFilters: filter?.media ? {
      services: filter.media.services,
      eventTypes: filter.media.event_types,
      eventAfter: filter.media.event_after,
      eventBefore: filter.media.event_before,
      eventBeforeExclusive: filter.media.event_before_exclusive,
    } : undefined,
  };
}

function diagnostic(result: SearchResult, index: number, relevantIds: ReadonlySet<string>, showContent: boolean): EvaluationDiagnostic {
  return {
    id: truncateUuid(result.id), source_key: result.source_key ?? null, rank: index + 1,
    vec_score: result.vec_score, text_score: result.text_score,
    diagnostic_base_score: result.base_score, relevance: result.relevance, final_score: result.final_score,
    relevant: relevantIds.has(result.id), ...(showContent ? { content: result.content } : {}),
  };
}

function assertFiniteResults(results: SearchResult[], caseId: string): void {
  const ids = new Set<string>();
  for (const result of results) {
    if (ids.has(result.id)) throw new Error(`Case ${caseId} returned duplicate result ${truncateUuid(result.id)}`);
    ids.add(result.id);
    for (const score of [result.text_score, result.base_score, result.relevance, result.final_score]) {
      if (!Number.isFinite(score)) throw new Error(`Case ${caseId} returned a non-finite score`);
    }
    if (result.vec_score !== null && !Number.isFinite(result.vec_score)) throw new Error(`Case ${caseId} returned a non-finite vector score`);
  }
}

function identityKey(identity: EvaluationIdentity): string { return 'source_key' in identity ? `key:${identity.source_key}` : `id:${identity.id}`; }
function displayIdentity(identity: EvaluationIdentity): string { return 'source_key' in identity ? `source_key:${identity.source_key}` : `id:${truncateUuid(identity.id)}`; }
function truncateUuid(id: string): string { return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id; }
function normalizeInstant(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new Error('as_of must be an ISO-8601 instant');
  return date.toISOString();
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
