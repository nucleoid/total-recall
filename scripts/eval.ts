import 'dotenv/config';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hnswEfSearchFromEnv } from '../src/config.js';
import {
  baselineMismatches,
  evaluationReportSchema,
  parseEvaluationDataset,
  runEvaluation,
  type EvaluationReport,
} from '../src/evaluation.js';
import { DEFAULT_SEARCH_RANKING_CONFIG, validateSearchRankingConfig } from '../src/search.js';
import { shutdown, type DbScope } from '../src/db.js';
import type { AccessLevel, SearchRankingConfig } from '../src/types.js';

type Cli = {
  dataset?: string; checkOnly: boolean; json: boolean; output?: string; baseline?: string;
  asOf?: string; threshold?: number; k?: number; ranking?: string; concurrency: number;
  showContent: boolean; allowUnresolved: boolean; force: boolean;
  minRecall?: number; minMrr?: number; maxRecallRegression?: number; maxMrrRegression?: number;
};

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (!cli.dataset) throw new Error('Required: --dataset <path>');
  const datasetRaw = JSON.parse(await readFile(resolve(cli.dataset), 'utf8')) as unknown;
  const dataset = parseEvaluationDataset(datasetRaw);
  const baseline = cli.baseline ? await readReport(cli.baseline) : undefined;
  const asOf = cli.asOf ?? baseline?.execution.as_of;
  const scope: DbScope = {
    keyId: requiredEnvironment('EVAL_KEY_ID'),
    namespaces: dataset.namespaces,
    isAdmin: process.env.EVAL_IS_ADMIN === 'true',
  };
  const maxAccessLevel = accessLevel(process.env.EVAL_MAX_ACCESS_LEVEL ?? 'normal');
  const ranking = rankingConfig(cli.ranking);

  if (!cli.checkOnly) {
    process.stderr.write(`Evaluation will make ${dataset.cases.length} embedding request(s) with concurrency ${cli.concurrency}; queries and reports are private.\n`);
  }
  const report = await runEvaluation(dataset, {
    scope, maxAccessLevel, asOf, ranking, k: cli.k, threshold: cli.threshold,
    allowUnresolved: cli.allowUnresolved, checkOnly: cli.checkOnly,
    showContent: cli.showContent, codeCommit: gitCommit(), efSearch: hnswEfSearchFromEnv(),
    databaseLabel: process.env.EVAL_DATABASE_LABEL, concurrency: cli.concurrency,
  });

  if (baseline && !cli.checkOnly) {
    const mismatches = baselineMismatches(report, baseline);
    if (mismatches.length && !cli.force) throw new Error(`Baseline is incompatible: ${mismatches.join(', ')} (use --force to report an observational comparison)`);
    if (mismatches.length) report.warnings.push(`Forced incompatible baseline comparison: ${mismatches.join(', ')}`);
    applyRegressionGate('recall@k', report.metrics.recall_at_k, baseline.metrics.recall_at_k, cli.maxRecallRegression);
    applyRegressionGate('MRR', report.metrics.mrr, baseline.metrics.mrr, cli.maxMrrRegression);
  }
  if (!cli.checkOnly) {
    applyMinimumGate('recall@k', report.metrics.recall_at_k, cli.minRecall);
    applyMinimumGate('MRR', report.metrics.mrr, cli.minMrr);
  }

  if (cli.output) await atomicJson(cli.output, report);
  if (cli.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (cli.checkOnly) process.stdout.write(`Valid: ${dataset.cases.length} case(s); identities resolved in authorized scope.\n`);
  else process.stdout.write(`recall@k=${format(report.metrics.recall_at_k)} mrr=${format(report.metrics.mrr)} hit-rate@k=${format(report.metrics.hit_rate_at_k)} cases=${report.metrics.evaluated_cases}\n`);
}

function parseArgs(args: string[]): Cli {
  const result: Cli = { checkOnly: false, json: false, concurrency: 1, showContent: false, allowUnresolved: false, force: false };
  const values = new Set(['--dataset', '--output', '--baseline', '--as-of', '--threshold', '--k', '--ranking', '--concurrency', '--min-recall', '--min-mrr', '--max-recall-regression', '--max-mrr-regression']);
  const booleans = new Set(['--check-only', '--json', '--show-content', '--allow-unresolved', '--force']);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (booleans.has(flag)) {
      if (flag === '--check-only') result.checkOnly = true;
      else if (flag === '--json') result.json = true;
      else if (flag === '--show-content') result.showContent = true;
      else if (flag === '--allow-unresolved') result.allowUnresolved = true;
      else result.force = true;
      continue;
    }
    if (!values.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--dataset') result.dataset = value;
    else if (flag === '--output') result.output = value;
    else if (flag === '--baseline') result.baseline = value;
    else if (flag === '--as-of') result.asOf = value;
    else if (flag === '--ranking') result.ranking = value;
    else if (flag === '--k') result.k = integer(value, flag, 1, 50);
    else if (flag === '--concurrency') result.concurrency = integer(value, flag, 1, 32);
    else {
      const number = boundedNumber(value, flag, flag === '--threshold' ? -1 : 0, 1);
      if (flag === '--threshold') result.threshold = number;
      else if (flag === '--min-recall') result.minRecall = number;
      else if (flag === '--min-mrr') result.minMrr = number;
      else if (flag === '--max-recall-regression') result.maxRecallRegression = number;
      else result.maxMrrRegression = number;
    }
  }
  return result;
}

function rankingConfig(raw: string | undefined): SearchRankingConfig {
  if (!raw) return validateSearchRankingConfig({ ...DEFAULT_SEARCH_RANKING_CONFIG });
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('--ranking must be a JSON object containing explicit internal overrides'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--ranking must be a JSON object');
  const allowed = new Set(Object.keys(DEFAULT_SEARCH_RANKING_CONFIG));
  const unknown = Object.keys(parsed).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Unknown ranking fields: ${unknown.join(', ')}`);
  return validateSearchRankingConfig({ ...DEFAULT_SEARCH_RANKING_CONFIG, ...parsed as Partial<SearchRankingConfig> });
}

async function readReport(path: string): Promise<EvaluationReport> {
  return evaluationReportSchema.parse(JSON.parse(await readFile(resolve(path), 'utf8'))) as EvaluationReport;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, target);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for request-scoped identity resolution`);
  return value;
}
function accessLevel(value: string): AccessLevel {
  if (value === 'normal' || value === 'sensitive' || value === 'secret') return value;
  throw new Error('EVAL_MAX_ACCESS_LEVEL must be normal, sensitive, or secret');
}
function integer(value: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  return number;
}
function boundedNumber(value: string, flag: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${flag} must be from ${min} to ${max}`);
  return number;
}
function gitCommit(): string | null {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
function applyMinimumGate(name: string, current: number, minimum: number | undefined): void {
  if (minimum !== undefined && current < minimum) throw new Error(`${name} ${format(current)} is below explicit minimum ${format(minimum)}`);
}
function applyRegressionGate(name: string, current: number, baseline: number, maximum: number | undefined): void {
  if (maximum !== undefined && baseline - current > maximum) throw new Error(`${name} regressed by ${format(baseline - current)}, exceeding explicit maximum ${format(maximum)}`);
}
function format(value: number): string { return value.toFixed(4); }

main().catch(error => {
  process.stderr.write(`Evaluation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => shutdown());
