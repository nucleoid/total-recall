# Webhook delivery least-privilege review

Scope reviewed: `scripts/webhook-delivery.ts`, `src/subscriptions.ts`, migration 029 policies and focused webhook tests. No shared authorization code or migration was changed by this task.

## Concrete risk

`runWebhookWorker()` authenticates `WEBHOOK_WORKER_API_KEY` with `validateKeyReadOnly()`, then `webhookWorkerScope()` requires both `admin` and `read`. `dbScopeFromAuth()` consequently sets `app.current_key_is_admin=true`. Migration 029's owner policies allow that scope to select/update **every** subscription and webhook-delivery row, regardless of key ID, while `read` also makes the key usable as a broad read credential elsewhere in the application. This is wider authority than the worker's actual claim/load/status-transition duties. A leaked worker key is therefore not delivery-only.

The current code does re-check key enablement, `read`, namespace membership, subscription status and normal-only memory eligibility immediately before connect, and checks again after DNS resolution. Those are useful delivery-time revocation controls, but they do not reduce the credential's capabilities outside this script.

## Minimal follow-up (separate owner change)

Add a dedicated `webhook_worker` API-key permission and forward migration. Expose narrowly shaped database functions for: claim one due row, load one claimed authorized metadata-only delivery, re-check authorization, cancel and transition delivered/retry/dead. Each function should:

- be `SECURITY DEFINER` with fixed `search_path`, revoked from `PUBLIC`, granted only to the application DB role;
- require the current enabled, unexpired key to contain `webhook_worker`;
- return only delivery IDs, metadata-only payload fields and encrypted endpoint/signing material needed by the sender;
- enforce the same live subscription/key/namespace/normal-memory predicates internally;
- constrain transitions by the claimed delivery ID and current `processing` state.

Then make `webhookWorkerScope()` require only `webhook_worker`, leave `isAdmin=false`, and reject that capability from normal read/write HTTP and MCP operations. Add database integration tests proving the key cannot select memories or arbitrary subscription/delivery rows, cannot claim under a revoked/expired key, and can perform only the bounded functions. This likely requires updating API-key permission validation/generation and a new forward migration; it should not be approximated in application code alone because current RLS cannot support global queue claiming without admin bypass.
