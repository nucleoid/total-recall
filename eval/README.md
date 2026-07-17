# Retrieval evaluation

This directory publishes the **v1 binary-judgment format**, not a production benchmark. `golden.example.json` is synthetic and makes no retrieval-quality claim.

## Private dataset

Create a gitignored file under `eval/private/`. Each case has a stable ID, query, ordinary search filters, optional `k`/threshold, and either one or more `relevant` identities or `expect_no_results: true`. Prefer a stable `source_key`. Because source keys are tenant-local in current databases, the resolver also rejects keys that are ambiguous in the authorized scope. Local UUIDs are accepted only when the dataset explicitly sets `"identity_mode": "local_uuid"`, and produce a warning. Duplicate judgments, grades, and an empty relevant set are rejected. The owner must curate judgments—never derive ground truth from current search output or recall traces.

Queries, identities, reports, and baselines are sensitive even when memory content is omitted. Keep them out of logs, shell arguments, CI artifacts, and source control. Full result content requires the explicit `--show-content` flag.

## Run

Use a dedicated read credential's database key UUID and authorized namespaces:

```sh
EVAL_KEY_ID=<api-key-uuid> EVAL_MAX_ACCESS_LEVEL=normal \
  npm run eval:check -- --dataset eval/private/golden.json

EVAL_KEY_ID=<api-key-uuid> EVAL_MAX_ACCESS_LEVEL=normal \
  npm run eval -- --dataset eval/private/golden.json \
  --as-of 2026-07-01T00:00:00Z --output eval/private/results/current.json
```

`--check-only` validates schema, duplicate judgments, credential scope, filters, and identity resolution without embedding or search. A normal run embeds each query once, runs serially by default (`--concurrency` is an explicit bounded override), and never updates access counters, agents, traces, or audit state. It reports macro recall@k, MRR, hit-rate@k, and case count. No-result cases are false-positive diagnostics and are excluded from recall/MRR.

Ranking overrides are internal evaluation experiments only:

```sh
--ranking '{"vectorWeight":0.4,"textWeight":0.6}'
```

They are validated and recorded in the report; they are not exposed through MCP, REST, or production environment variables.

## Baselines and gates

A fixed `--as-of` freezes relevance decay. When `--baseline` is supplied without `--as-of`, the baseline time is reused. Comparison refuses dataset, ranking, filters/k/threshold, embedding descriptor/dimension, ef_search, time, or report-schema mismatches. `--force` labels every mismatch as an observational comparison.

Reports include the dataset/config/ranking hashes, commit, active embedding descriptor, dimension, ef_search, fixed time, per-case metrics, and score diagnostics. The active descriptor is evidence, not proof that every historical row uses a compatible embedding.

Low quality does not fail a default run. Absolute gates (`--min-recall`, `--min-mrr`) and compatible regression gates (`--max-recall-regression`, `--max-mrr-regression`) are opt-in. Do not add a CI/release gate until the owner has reviewed a representative private dataset and observed a stable baseline.

Output is written atomically after a complete run. `--json` prints sensitive report JSON to stdout; prefer a private `--output` path.
