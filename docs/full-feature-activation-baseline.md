# Full-feature activation baseline (2026-11-24)

This is an activation plan, not a claim that dormant features work in production. The owner-approved scope now includes **all already-stored memories**, including `financial`, `my-life`, `sensitive`, and `secret`, only when the executing API key genuinely authorizes both the namespace and access-level ceiling. This does not authorize new raw My Life acquisition. Local-only embeddings, per-key namespace isolation, source sensitivity, resource guards, and independent write approvals remain mandatory.

## Capability inventory

| Capability | Supported in release | Observed production state | Activation boundary |
|---|---|---|---|
| Local embeddings/search | Yes | Active local Qwen contract | Keep unchanged; synthesis never replaces or exports embeddings |
| Queue ingestion: store/update/document/session | Yes | Active after durable-ingestion repair | Session storage is active; distillation is separate |
| Consolidation | Exact-level selection/preview/apply for normal, sensitive, or secret | Run table initially empty | Run one namespace and one access-level lane at a time with an authorized key; subscription preview before separate write-approved apply |
| Reflection | Bounded weekly windows; all-level policy/read/output support in this branch | Run table empty | Apply migration 054; provision a dedicated `read,reflection` key with source namespaces + `insights`, no `write/admin/delete`; dry run first |
| Session distillation | Exact-lane all-level queue worker in this branch | No completed runs observed | Apply migration 056; provision a dedicated `read,session_distill` key without ordinary mutation permissions; canary one namespace/level lane |
| Entity graph | Extraction queue, entities, links, graph query | Entity/link tables empty | Still normal-only; requires bounded backfill preview and all-level worker review |
| Contradictions | Shadow classification and gated mutation | Classification/mutation gates off | Enable shadow classification only; mutation needs reviewed metrics and exact environment |
| Supersession | Finalizer and reversible search demotion | Demotion not proven active | Finalize schema, verify, then separately enable score factor |
| Subscriptions/webhooks | Creation and bounded public-HTTPS delivery | Creation/delivery off | Encryption ring + exact worker key; creation and delivery are separate gates |
| Taste profile | Evidence-bounded preview/apply | No native run evidence | Media-derived path remains normal-only; all-level/subscription policy support remains to implement |
| Decay/lifecycle | TTL/decay, validity, purge/finalizers | Supported; optional schedules not proven | Owner-only finalizers first, then small daily batch |
| Archive/preseed | OpenClaw/Claude/Gemini/ChatGPT and archive gateway | Stored My Life archive exists | Existing stored records are eligible through authorized native synthesis; no new raw acquisition scope |
| Media connectors | Spotify, YouTube Music, Plex, browser history | Parent reports media repaired/verified | Do not replay; one scheduler owner per connector |
| Existing Cass synthesis | OpenClaw user-model synthesis | Active comparison baseline | Does not populate native run tables |

Point-in-time, content-free evidence is recorded in `artifacts/total-recall-active-features-20261124.md`.

## Verified OpenClaw subscription dependency

`src/generation-gateway-adapter.ts` converts Total Recall's bounded generation contract to OpenClaw's official chat-completions endpoint through a dedicated isolated agent. Subscription-mode native policies must set:

- `generation.provider: openclaw-adapter`
- `generation.model: openclaw/total-recall-synthesis`
- `generation.endpoint`: the private adapter URL
- `generation.credentialEnv: GENERATION_API_KEY`
- `budget.mode: subscription`, with explicit per-run call/output-byte limits and a usage-control reference

Subscription mode forbids a direct provider/model bypass and does not require fabricated USD prices. Legacy paid-budget policy fields remain accepted for backward compatibility.

The parent has verified the private TLS path from the real ingestion worker: health 200, missing bearer 401, and authenticated synthetic generation 200. The OpenClaw operator token remains only on Fuego. Workers receive only the adapter bearer and private CA. The isolated agent is pinned to the approved existing subscription with no fallback. This transport verification does **not** activate any native feature.

## Reflection security contract in this stage

Reflection now:

1. selects source records only up to the policy access-level ceiling;
2. requires every requested source namespace plus `insights` to exist on the executing key;
3. requires the dedicated native `reflection` permission and forbids `write`, `admin`, and `delete`, preserving migration 031 RLS isolation;
4. revalidates evidence content/revisions and access levels before applying output;
5. classifies every derived insight at the maximum sensitivity of all materialized prompt inputs (plus revalidated current levels), regardless of which evidence IDs the model cites, and refuses reuse of a lower-classified insight;
6. uses bounded subscription calls/output bytes with zero fabricated USD accounting.

Migration 054 is forward-only. It broadens consolidation metadata checks to the three existing access levels and replaces only the reflection insert policy's fixed-normal condition with a check against the current key's `max_access_level`. It does not grant a key, mutate memories, enable a worker, or relax namespace/permission/provenance guards.

## Exact activation prerequisites

Parent-owned deployment steps, in order:

1. Deploy this release and apply migration 054 through the normal migration runner. Do not replay migration 027 or 031.
2. Through supported key management, create or amend a **reflection-specific** key with all intended stored source namespaces plus `insights`, `max_access_level=secret`, permissions `read,reflection` (optionally `consolidate` only if another reviewed native path needs it), and no `write/admin/delete`. The previously created general synthesis key has `write` and lacks `insights`/`reflection`, so it must not run reflection as-is.
3. Store that key only in `REFLECTION_API_KEY`. Keep the adapter bearer in `GENERATION_API_KEY`; these are different credentials.
4. Set `REFLECTION_POLICY_FILE` to a reviewed subscription policy. Runtime also requires `DEPLOYMENT_ENVIRONMENT`, `GENERATION_ENDPOINT` mapped into policy JSON, `GENERATION_API_KEY`, and `NODE_EXTRA_CA_CERTS` for the private CA.
5. Run `npm run reflect -- --namespace <authorized> --dry-run` independently for each namespace. A multi-namespace key does not merge namespaces: each run remains scoped to one origin namespace and writes origin-tagged insights.
6. Review content-free counts, access-level distribution, malformed-output rate, call/output-byte usage, and local embedding health. Only then schedule one completed ISO week at a time with no overlapping invocation.

## Other feature sequence
Session distillation is a separate activation lane:

1. Apply forward migration 056 after deploying the matching API/worker release; do not replay migrations 030, 053, 054, or 055.
2. Provision `SESSION_DISTILLATION_API_KEY` through supported key management with the intended stored namespaces, `max_access_level=secret`, permissions `read,session_distill`, and no `write/admin/delete`. Source-owner keys remain independently enabled with `read,write` and the matching namespace/access ceiling.
3. Review one subscription policy per exact namespace/access-level lane. Set `SESSION_DISTILLATION_POLICY_FILE`, `DEPLOYMENT_ENVIRONMENT`, `GENERATION_API_KEY`, and `NODE_EXTRA_CA_CERTS`; keep the adapter endpoint private.
4. Keep the shared ingestion worker active so generated facts receive local embeddings. The distillation worker does not impersonate owners or embed through a remote generation provider.
5. Run `npm run session:distill -- --once --max-jobs 1`, then verify content-free run/lineage/access-level counts and local embedding readiness before scheduling any additional lane.


- Consolidation: run `--selection-only`, preview, and separately write-approved apply for one exact namespace/access-level lane at a time; never combine levels in one cluster.
- Entity: bounded backfill preview, then at most 10 jobs per invocation after all-level policy/query work lands.
- Taste: dry run before apply; current media path remains normal-only.
- Session distillation: apply migration 056, then canary one exact namespace/access-level lane with the dedicated non-admin key; derived facts remain owner-attributed and queue only local embedding work.
- Contradiction: classification shadow only, in-flight 1 and queue 4; mutation remains off.
- Supersession: run finalizer, inspect report, then canary search demotion.
- Subscriptions: creation only after encryption/key backup review; delivery separately, concurrency 1 initially.
- Decay/lifecycle: existing bounded daily batches only.

## Remaining implementation work

This stage completes all-level, subscription-native reflection, consolidation, and session-distillation vertical slices. Session distillation remains inactive until migration 056, dedicated key provisioning, deployment, and live canary acceptance. Entity extraction and taste profiling still have normal-only policy/query/worker gates and legacy USD-only budget schemas; do not schedule those features yet.

## Acceptance gates

For every feature: policy hash and approvals valid; executing key authorizes every namespace and the requested level; derived output is never lower-classified than evidence; one scheduler owner; bounded no-overlap execution; content-free metrics; no secrets in logs; local embeddings remain active; rollback disables only that feature. Mutation/apply operations retain separate write approval. Parent owns deployment, migration application, scheduler changes, secrets, keys, and live verification.
