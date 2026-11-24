# Bounded relevance calibration and logical decay

This procedure is operator-only and non-destructive. It never physically deletes expired memories. Logical TTL remains enforced by normal reads. `purgeExpiredMemories` is a separate dangerous API and is not called by `npm run decay:update`.

## Historical base calibration

Calibration reconstructs a nonnegative base that preserves the row's existing effective `relevance_score` at one explicit `asOf` instant:

`base = (effective score - bounded access bonus) / exp(-decay rate * age at asOf)`

This is an operator calibration, not evidence that the reconstructed value was the unknown original base. Rows with non-finite inputs, an effective score below their access bonus, underflowed factors, or reconstruction drift are rejected with a content-free reason and remain NULL.

1. Stop scheduled decay and freeze recall/access writes. Take and verify a restorable database backup.
2. Choose one UTC `asOf` and keep it unchanged for every page in this calibration run.
3. Preview at most 1,000 rows:
   `npm run repair:relevance-scores -- --calibration-preview calibration-001.json --as-of 2026-11-24T12:00:00Z --limit 100`
4. Review every candidate. Build a version-1 manifest containing `backupVerified: true`, a non-secret `backupEvidenceReference` from the operator ledger, the exact preview `asOf`, and only approved `{id,fingerprint,derivedBaseScore,preservedEffectiveScore}` entries. Never approve rejected rows.
5. Apply that exact page:
   `npm run repair:relevance-scores -- --calibration-apply calibration-001-approved.json`
6. Verify `updated`, `alreadyApplied`, `remaining`, and the content-free `relevance_base_calibration` audit event. Replay of the same manifest is safe and reports already applied rows; changed score/access/timestamp facts fail fingerprint validation.
7. Continue from `nextCursor` using `--after <uuid>`. Start another pass from the beginning after any concurrent insert window.
8. Only when an independent query and every apply report prove zero NULL bases, finalize separately:
   `npm run repair:relevance-scores -- --finalize-calibration --backup-verified`

Batch apply never validates or sets `NOT NULL`. Uncertain or unsafe rows stay unchanged and block finalization.

## Bounded logical decay

Use one fixed UTC instant for a full pass. Preview and apply are bounded to 1–1,000 active, unexpired, unsuperseded, unconsolidated rows with valid bases. Candidate rows are locked with `SKIP LOCKED`; the update rechecks all score inputs and never processes NULL bases.

- Dry run: `npm run decay:update -- --as-of 2026-11-24T12:00:00Z --limit 100 --dry-run`
- Apply: `npm run decay:update -- --as-of 2026-11-24T12:00:00Z --limit 100 --apply`
- Continue: append `--after <nextCursor>` while retaining the same `asOf`.

A replay with identical facts and `asOf` reports zero updates. The command does not purge TTL rows, finalize schema constraints, infer missing bases, or process logically inactive rows. Parent operations own backup evidence, the classification ledger, scheduler pause/resume, live previews, application, and verification.
