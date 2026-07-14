# Rollout impact — issue #53

## Configuration and external processing

- Contradiction classification and automatic mutation are both disabled by default.
- Enabling classification requires new, feature-specific provider/model, generation endpoint/key, privacy/retention/training, one-namespace normal-access scope, and budget approvals documented in `.env.example` and `README.md`.
- Embedding credentials and other generative-feature approvals do not enable this feature.
- Automatic mutation separately requires reviewed shadow metrics, explicit approval, and an exact deployment-environment match.

## Migration and backfill

- Migration 025 is additive. It adds kind/validity/supersession columns, NOT VALID checks/FK, and the durable unique supersession index.
- Existing `valid_from` values remain null until the owner runs the bounded, resumable `npm run backfill:memory-validity` command. New writes receive a database timestamp.
- After pending reaches zero, the owner must run `npm run finalize:memory-validity`; it validates constraints, sets `valid_from NOT NULL`, and builds candidate/temporal indexes concurrently.
- `valid_at` and contradiction classification fail closed until finalization. Deploy migration before kind-aware writers, then backfill/finalize before temporal readers or shadow processing.

## Compatibility and rollback

- Ordinary behavior is preserved while classification is disabled. Non-store ingestion paths never classify and now write explicit kinds.
- Mixed old writers produce `unspecified` rows and reduced detection coverage; drain/upgrade writers before enablement.
- Roll back by disabling automatic mutation first, then classification. Never automatically reopen validity intervals. Retain populated additive columns and deploy no reader that lacks supersession handling after links exist.
- No destructive action, user reauthentication, API-key rotation, ingress/TLS change, or planned downtime is required.
