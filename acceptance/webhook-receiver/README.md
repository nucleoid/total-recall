# Total Recall signed-webhook acceptance receiver

Disposable Cloudflare Worker used only to prove Total Recall's real network delivery, signing, retry and replay behavior. It has no outbound fetch path and cannot act as an arbitrary recipient/proxy. It accepts only the configured subscription, memory and namespace, and stores only IDs, timestamps, attempt count and the SHA-256 of the exact body.

The `AcceptanceState` Durable Object is required: process memory and the Cache API cannot honestly prove retry state survives isolate replacement. SQLite-backed Durable Objects are supported on Workers Free; this receiver needs one object for the single configured event and no paid resource. Delete the Worker after acceptance.

## Deploy (parent/operator)

Prerequisites: authenticated Wrangler access to the existing Cloudflare account, and the exact subscription ID, acceptance memory ID/namespace and signing secret returned when that subscription was created. Do not paste secrets into `wrangler.toml`, command arguments or logs.

Because the subscription is prospective but the receiver pins the generated memory ID, keep the Total Recall delivery worker disabled while preparing acceptance: create the subscription using the deterministic Workers URL below, store the one acceptance memory and capture its returned ID, then deploy this receiver with those exact values before starting delivery. Creating the memory while delivery is active can consume the event against an unconfigured receiver and is not an acceptance proof.

```bash
cd acceptance/webhook-receiver
npx --yes wrangler@4 secret put WEBHOOK_SIGNING_SECRET
npx --yes wrangler@4 secret put RECEIPT_BEARER
npx --yes wrangler@4 secret put RECEIPT_SIGNING_SECRET
npx --yes wrangler@4 deploy \
  --var EXPECTED_SUBSCRIPTION_ID:<subscription-uuid> \
  --var EXPECTED_MEMORY_ID:<memory-uuid> \
  --var EXPECTED_NAMESPACE:<namespace>
```

Generate the receipt bearer and receipt-signing secret independently (at least 32 random bytes each). The public webhook URL is:

`https://total-recall-webhook-acceptance-20261124.nucleoid-cass.workers.dev/webhook`

Create the Total Recall subscription with that URL. Keep the returned webhook signing secret private and install the exact same value as `WEBHOOK_SIGNING_SECRET`. The Total Recall sender's SSRF controls still resolve and pin the public Workers address; this receiver itself performs no network egress.

## Acceptance proof

1. Store the one configured metadata-only acceptance memory after the subscription is active.
2. The receiver durably records the first valid exact-body delivery and returns `503` with `Retry-After: 1`.
3. Total Recall should schedule a retry (its own bounded backoff may be longer than one second). The second identical delivery transitions the Durable Object to accepted and returns `204`. Later identical replays remain `204`; reuse of the event ID with different exact bytes returns `409`.
4. Fetch the content-free receipt privately:

   ```bash
   curl --fail-with-body \
     -H "Authorization: Bearer $RECEIPT_BEARER" \
     "https://total-recall-webhook-acceptance-20261124.nucleoid-cass.workers.dev/receipts/<event-uuid>" \
     --dump-header receipt.headers --output receipt.json
   ```

5. Verify `x-total-recall-receipt-signature` as HMAC-SHA256 over the exact `receipt.json` bytes using `RECEIPT_SIGNING_SECRET`. Confirm `status=accepted`, exact IDs and `attempt_count=2`. Correlate that event ID with Total Recall's delivery row/audit evidence. Do not treat a receipt alone as proof of the sender-side retry scheduler.

Wrangler/Cloudflare request logs must remain disabled or metadata-only; the code never logs bodies, signatures, bearer values or secrets.

## Cleanup

First disable the temporary Total Recall subscription and confirm no delivery remains pending. Preserve only the content-free receipt and sender-side delivery/audit evidence required by the acceptance record. Then remove the Worker:

```bash
cd acceptance/webhook-receiver
npx --yes wrangler@4 delete --name total-recall-webhook-acceptance-20261124
```

Cloudflare may retain Durable Object storage after Worker deletion depending on platform lifecycle. If account-level storage cleanup is required, deploy a follow-up migration with `deleted_classes = ["AcceptanceState"]` only after preserving evidence; do not reuse the class/name for production state.

## Focused tests

```bash
node --test test/receiver.test.mjs
```
