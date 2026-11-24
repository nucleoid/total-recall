# Full-feature activation baseline (2026-11-24)

This is an activation plan, not a claim that dormant features work in production. It preserves local-only embeddings, normal-only synthesis scope, My Life exclusion, existing resource guards, and independent approval gates.

## Capability inventory

| Capability | Supported in release | Observed production state | Activation boundary |
|---|---|---|---|
| Local embeddings/search | Yes | Active Qwen local contract; caught-up ingestion reported after repair | Keep unchanged; never route embeddings through synthesis |
| Queue ingestion: store/update/document/session | Yes | Four gates active; worker ready/retry queue repaired | Session storage is active; distillation is separate |
| Consolidation | Selection, preview and apply | Run table empty | Approved policy + normal-only key + adapter; preview before write approval |
| Reflection | Bounded weekly windows | Run table empty | Approved policy + normal-only key + adapter; dry run first |
| Session distillation | Durable queue worker | No completed runs observed | Approved policy + exact namespace normal-only key + adapter |
| Entity graph | Extraction queue, entities, links, graph query | Entity/link tables empty | Approved policy + bounded backfill preview + worker |
| Contradictions | Shadow classification and gated mutation | Classification/mutation gates off | Enable shadow classification only; mutation requires reviewed metrics and exact environment |
| Supersession | Finalizer and reversible search demotion | No evidence demotion enabled | Finalize schema, verify, then separately enable score factor |
| Subscriptions/webhooks | Creation and bounded public-HTTPS delivery | Creation/delivery off; table empty | Encryption ring + exact worker key; creation and delivery are separate gates |
| Taste profile | Evidence-bounded preview/apply | No native run evidence | Approved policy + media evidence + adapter; preview first |
| Decay/lifecycle | TTL/decay, validity, purge/finalizers | Supported; optional schedules not proven | Owner-only finalizers first, then small daily batch |
| Archive/preseed | OpenClaw/Claude/Gemini/ChatGPT and archive gateway | My Life archive heavily populated; this is storage, not native understanding | No new raw archive scope; keep sensitive/secret/financial excluded |
| Media connectors | Spotify, YouTube Music, Plex, browser history | Media rollups exist; old external pre-cutover cron is obsolete | Use tracked release-relative launcher; one owner per connector |
| Existing Cass synthesis | Weekly OpenClaw user-model synthesis | Active and delivered | Keep as comparison baseline; it does not populate native run tables |

Live evidence source: 'artifacts/total-recall-active-features-20261124.md' in the agent workspace. Counts are point-in-time and intentionally content-free.

## OpenClaw synthesis dependency

'src/generation-gateway-adapter.ts' converts the existing bounded Total Recall contract to OpenClaw's official 'POST /v1/chat/completions' API.

1. On Fuego, enable 'gateway.http.endpoints.chatCompletions.enabled'.
2. Create dedicated agent 'total-recall-synthesis', backed by the owner-approved OpenClaw/Codex model.
3. Deny **all internal tools** for that agent. 'tool_choice: none' only disables caller-supplied HTTP tools and is not an internal-tool sandbox.
4. Install the adapter env/service templates on Fuego. Keep the OpenClaw bearer credential there, mode 0600.
5. Allow only 'openclaw/total-recall-synthesis'. Do not use 'x-openclaw-model'; backend selection belongs to the reviewed agent config.
6. Workers use only the adapter token. Either run synthesis workers on Fuego against approved private DB/embedding routes, or bind the adapter to a private firewalled interface for Dappnode. Never expose either endpoint publicly.
7. Smoke test '/v1/models' and one synthetic, non-memory adapter request before any dry run.

The adapter accepts canonical loopback HTTP ('127.0.0.1') or HTTPS upstream only, requires the exact chat-completions path, bounds request/response bytes and time, rejects tools, and allowlists agent targets.

**Current blocker:** endpoint enablement, the dedicated tool-denied agent, its approved OpenClaw/Codex backend, private Fuego-to-worker route, and provider cost terms/budgets have not been verified. Therefore no native synthesis schedule is ready to turn on merely by installing these files.

## Activation sequence and bounded schedules

Use one namespace with 'access_level=normal'. Explicitly exclude 'my-life', 'sensitive', 'secret', and financial scope in every policy/key.

1. Verify migrations/finalizers and current release. Keep ingestion and local embeddings green.
2. Install and test the OpenClaw adapter dependency above.
3. Create native policy files using each feature's strict schema. Set 'generation.provider' to 'openclaw-adapter', 'generation.model' to 'openclaw/total-recall-synthesis', endpoint to the private adapter, and a dedicated credential env. Record exact privacy/retention/training, scope and conservative cost approvals; do not use placeholder estimates.
4. Run content-free previews:
   - consolidation: 'npm run consolidate -- --selection-only --namespace <approved>' then '--dry-run --preview-output <owner-file>';
   - reflection: 'npm run reflect -- --namespace <approved> --dry-run';
   - entity: 'npm run entity:backfill -- --namespace <approved>' preview, then 'entity:enrich -- --once --max-jobs 10';
   - taste: 'npm run taste-profile -- --dry-run';
   - session: 'npm run session:distill -- --once --max-jobs 5'.
5. Review receipts, costs, malformed-output rates and local embedding health. Add bounded jobs only after clean previews:
   - session/entity: every 10 minutes, max 10 jobs, no overlapping invocation;
   - reflection: weekly, one completed ISO week;
   - taste: weekly;
   - consolidation: weekly selection/preview; apply remains separately write-approved;
   - decay: daily with existing batch limits;
   - webhook delivery: one worker, concurrency 1 initially.
6. Enable contradiction **classification shadow only** with in-flight 1 and queue 4. Mutation stays false until shadow metrics are explicitly reviewed.
7. Run supersession finalizer once, verify its report, then canary 'SUPERSEDED_SEARCH_DEMOTION_ENABLED=true' with default factor 0.25.
8. Enable subscription creation only after encryption/key backup and endpoint ownership review; enable delivery separately.
9. Connector schedules call 'scripts/run-connector-sync.sh <connector>' from the active release. Remove the obsolete '--phase pre-cutover' wrapper only during parent-owned scheduler cutover.
10. Install the daily timer on the Dappnode 'cass' account with 'WATCHER_OWNERSHIP=external'; it must observe exactly one watcher and can never start/adopt another.

## Acceptance gates

For each feature: policy hash/expiry valid; dedicated key exact scope; no protected namespace; one scheduler owner; bounded no-overlap run; content-free metrics; no secret in logs; local embedding contract still active; rollback is disabling only that feature's schedule/gate. Mutation/apply jobs need their own write approval. Parent owns deployment, scheduler cutover, secrets, API keys, SQL/finalizers and live verification.
