# Webhook delivery least-privilege review

Scope reviewed: `scripts/webhook-delivery.ts`, `src/subscriptions.ts`, migration 029 policies and focused webhook tests. No shared authorization code or migration was changed by this task.

## Concrete risk

`runWebhookWorker()` authenticates `WEBHOOK_WORKER_API_KEY` with `validateKeyReadOnly()`, then `webhookWorkerScope()` requires both `admin` and `read`. `dbScopeFromAuth()` consequently sets `app.current_key_is_admin=true`. Migration 029's owner policies allow that scope to select/update **every** subscription and webhook-delivery row, regardless of key ID, while `read` also makes the key usable as a broad read credential elsewhere in the application. This is wider authority than the worker's actual claim/load/status-transition duties. A leaked worker key is therefore not delivery-only.

The current code does re-check key enablement, `read`, namespace membership, subscription status and normal-only memory eligibility immediately before connect, and checks again after DNS resolution. Those are useful delivery-time revocation controls, but they do not reduce the credential's capabilities outside this script.

## Implemented follow-up (migration 059)

Migration `059_webhook_worker_least_privilege.sql` and the matching runtime change add a dedicated `webhook_worker` API-key permission and narrowly shaped database functions for: claim one due row, load one claimed authorized metadata-only delivery, re-check authorization, cancel and transition delivered/retry/dead. Each function:

- be `SECURITY DEFINER` with fixed `search_path`, revoked from `PUBLIC`, granted only to the application DB role;
- requires the current enabled, unrevoked, unexpired key to have exactly the single `webhook_worker` permission;
- return only delivery IDs, metadata-only payload fields and encrypted endpoint/signing material needed by the sender;
- enforce the same live subscription/key/namespace/normal-memory predicates internally;
- constrain transitions by the claimed delivery ID and current `processing` state.

Restrictive RLS policies deny raw memory, document, subscription namespace, subscription, and delivery table access for that capability without replacing migration 057's entity policies. `webhookWorkerScope()` leaves `isAdmin=false`; ordinary HTTP/MCP permission checks reject the key because it has neither `read` nor `write`.

## Owner rollout prerequisites

1. Merge and apply migration 057 first. Migration 058 remains reserved; do not renumber or reuse it.
2. Merge this branch and apply migration 059 with the normal owner-run migration process while writers are controlled under the existing rollout procedure.
3. Create a new API key with only the delivery namespaces and capability:

   ```sh
   npm run create-key -- --name webhook-delivery --namespaces <comma-separated-delivery-namespaces> \
     --permissions webhook_worker --max-access-level normal --expires 30d \
     --rpm <bounded-value> --daily-quota <bounded-value>
   ```

4. Put only that generated value in `WEBHOOK_WORKER_API_KEY`. Do not reuse the former `admin,read` worker key. Keep `WEBHOOK_DELIVERY_ENABLED=false` until migration/readback, key readback, receiver configuration, and acceptance preflight all pass.
5. Read back the database key row and verify: `permissions = {webhook_worker}`, `max_access_level = normal`, namespaces are exactly the intended delivery namespaces, and expiry/revocation state is current. Then run one bounded `--once --max-jobs 1 --concurrency 1` preflight before enabling the long-running worker.
6. After acceptance, revoke the old worker credential. Rollback is to stop delivery and revoke the new key; migration 059 is forward-only and should not be manually removed while its runtime is deployed.

No deployment, key creation, database migration, scheduler change, or worker activation is performed by this branch.
