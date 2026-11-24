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

## Reviewed earned-bonus floor exceptions

Rows rejected as `effective_score_below_access_bonus` are never normalized automatically. The only supported exception sets `relevance_base_score=0` and raises the effective score to the already-earned capped access bonus. It does not infer an original base, reset a row to 1, or change content, source, namespace, access level, owner/provenance, access count, or access timestamp. Preview, apply, and rollback each refuse rows that are expired or otherwise inactive at the database statement timestamp, even if they were active at the historical calibration `asOf`.

1. Keep recall/access writes frozen and retain the verified pre-repair backup. Create a private JSON file containing an array of 1–1,000 exact UUIDs, or `{ "ids": [...] }`.
2. Preview only those IDs into a new mode-0600 file:
   `npm run repair:relevance-scores -- --floor-exception-preview floor-preview.json --ids floor-ids.json`
3. Review every candidate. Eligible rows report the before-state and guard fingerprints, current score, capped earned bonus, proposed base `0`, and proposed score equal to that bonus. Rejected, missing, non-finite, already-classified, expired, future-valid, superseded, consolidated, or non-below-floor rows cannot apply.
4. Build a private version-1 manifest with `kind: "access_bonus_floor_exception"`, `operatorApproved: true`, non-secret `operatorReviewReference` and `backupEvidenceReference`, `backupVerified: true`, and only exact reviewed approval fields from the preview.
5. Apply the bounded manifest explicitly:
   `npm run repair:relevance-scores -- --floor-exception-apply floor-approved.json`
   Rows are locked and all ACL, provenance, lifecycle, access history, score, and content-hash guard facts are revalidated. Replay writes nothing and reports `alreadyApplied`. Any drift aborts the transaction.
6. Verify exact before/current scores, base `0`, unchanged source and access-history fields, remaining NULL count, and the content-free `relevance_base_floor_exception` audit entry. Finalization still refuses while any NULL base remains.
7. To roll back before writes resume, use the same reviewed manifest:
   `npm run repair:relevance-scores -- --floor-exception-rollback floor-approved.json`
   Rollback locks and revalidates the applied state, restores the exact reviewed pre-repair score and NULL base, records `relevance_base_floor_exception_rollback`, and is replay-safe. If lifecycle or guard facts drift, stop and restore through the referenced verified backup rather than forcing a write. A rolled-back NULL row again blocks finalization and requires a fresh preview before any later repair.

## Bounded logical decay

Use one fixed UTC instant for a full pass. Preview and apply are bounded to 1–1,000 active, unexpired, unsuperseded, unconsolidated rows with valid bases. Candidate rows are locked with `SKIP LOCKED`; candidate selection and the update both require lifecycle validity at the current statement timestamp as well as the fixed `asOf`, recheck all score inputs, and never process NULL bases.

- Dry run: `npm run decay:update -- --as-of 2026-11-24T12:00:00Z --limit 100 --dry-run`
- Apply: `npm run decay:update -- --as-of 2026-11-24T12:00:00Z --limit 100 --apply`
- Continue: append `--after <nextCursor>` while retaining the same `asOf`.

A replay with identical facts and `asOf` reports zero updates. The command does not purge TTL rows, finalize schema constraints, infer missing bases, or process logically inactive rows. Parent operations own backup evidence, the classification ledger, scheduler pause/resume, live previews, application, and verification.
