# Memory subscriptions and webhook delivery

Memory subscriptions are prospective semantic interests. A new `normal` memory whose stamped embedding space and cosine score match an active subscription creates an outbox row in the same database transaction. That transaction is the insert when the memory arrives with its embedding, or the finalization that lands the embedding when the memory was accepted through the [durable ingestion queue](ingestion-queue.md): content updates do not create events; the pending to ready transition is the creation event. Deletes, boosts, historical rows, `sensitive`/`secret` rows, unstamped vectors, and vectors from another embedding space do not create events. Matching is deterministic and capped at 100 subscriptions per memory.

Two database triggers call the same enqueue function: `memories_subscription_enqueue` (`AFTER INSERT`, migration 029) and `memories_ingestion_subscription_enqueue` (`AFTER UPDATE OF embedding` from NULL to a vector, migration 037). Both ship disabled and must be enabled and disabled together; with only the insert trigger enabled, a memory that was queued at store time never notifies. The outbox's unique `(subscription_id, memory_id, event_version)` row makes a replayed finalization harmless, and the function skips a memory whose ingestion job has `kind = 'update'`, so a later content re-embed is never a creation event.

## Enablement and operation

Creation and delivery have separate fail-closed gates:

```dotenv
MEMORY_SUBSCRIPTION_CREATION_ENABLED=true
WEBHOOK_DELIVERY_ENABLED=true
WEBHOOK_ENCRYPTION_KEYS=2026-01:<base64-32-byte-key>,2025-12:<previous-key>
WEBHOOK_WORKER_API_KEY=tr_dedicated_admin_read_key
```

The first encryption key is current. Keep previous keys until all rows have been rotated or retired. The worker key must be a dedicated enabled API key with `admin` and `read`, `normal` access, and every namespace that it may deliver. Start the bounded worker with:

```sh
npm run webhooks:deliver -- --concurrency 4
# canary/drain mode
npm run webhooks:deliver -- --once --max-jobs 100
```

Subscription creation embeds a query once. `idempotency_key` is required and scoped to the authenticated API key. An identical retry returns the same subscription and signing secret; reuse with a changed canonical request is a conflict. `agent_list_subscriptions` never returns the secret or raw URL. `agent_unsubscribe` disables the subscription and cancels undelivered rows without deleting audit/history.

## Receiver contract

The worker sends canonical UTF-8 JSON with no memory content, summary, tags, source, agent provenance, or arbitrary metadata:

```json
{"event_id":"7e23...","memory":{"created_at":"2026-01-02T03:04:05.000Z","id":"5c91...","namespace":"shared"},"subscription_id":"99c0...","type":"memory.stored","version":1}
```

Object keys are recursively sorted. Headers include:

- `X-Total-Recall-Event-Id: <stable UUID>`
- `X-Total-Recall-Signature: sha256=<lowercase HMAC-SHA256 hex over the exact body bytes>`

Use the signing secret returned only by `agent_subscribe`, verify the exact body before parsing, and deduplicate by event ID. Delivery is **at least once**: a worker crash after receiver success can redeliver. The receiver must call `memory_recall` with its own API key to obtain content, so current key, namespace, and access-level authorization remains independent of webhook delivery.

Network failures, 408, 425, 429, and 5xx retry with bounded jitter around 1m/5m/30m/2h/12h. Other 4xx and redirects dead-letter. Attempts have a five-second total deadline by default, bounded response bytes, and no redirects or proxy-environment inheritance.

## Destination policy

Only public HTTPS destinations on port 443 are accepted. URLs with user-info or fragments are rejected. Registration and every attempt resolve all returned addresses; loopback, private, link-local, multicast, unspecified, documentation, metadata, and noncanonical IP forms are rejected. The request connects to a validated pinned address while normal TLS SNI and hostname verification use the URL hostname. There is no caller-controlled private-network bypass.

## Rollout and rollback

1. Apply migration 029. Creation and delivery are disabled, and the migration leaves `memories_subscription_enqueue` disabled as the database-side kill switch.
2. Configure the encryption key ring and dedicated worker key.
3. Enable and canary the worker with no subscriptions.
4. After measuring insert plans/latency, explicitly enable the trigger pair as the database owner in one statement: `ALTER TABLE public.memories ENABLE TRIGGER memories_subscription_enqueue, ENABLE TRIGGER memories_ingestion_subscription_enqueue;` (the second trigger exists once migration 037 is applied; see the [migration 037 runbook](rollouts/037-memory-ingestion-queue.md)).
5. Enable creation for keys restricted to one approved namespace, then widen deliberately.

There is no backfill or query replay. Rollback by disabling creation, stopping the worker, and disabling both triggers together: `ALTER TABLE public.memories DISABLE TRIGGER memories_subscription_enqueue, DISABLE TRIGGER memories_ingestion_subscription_enqueue;`. Retain encrypted subscriptions, content-free outbox history, and audit rows. Delivery/truncation rows intentionally do not hold a foreign key to `memories`: hard deletion may remove memory content while retaining only its former opaque ID in notification history. Disabling a subscription/key or narrowing an ACL wins before a new connection, but cannot recall an HTTP request already in flight. Content-bearing payloads and private-network destinations require a separate policy and contract review.
