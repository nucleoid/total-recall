# Connector runtime deployment

## Release artifact

'npm run build:connectors' bundles Spotify, YouTube Music, Plex and browser entrypoints into 'dist/connector-runtime'. The tracked 'scripts/run-connector-sync.sh' resolves its own release and executes only these compiled files with the explicitly configured absolute 'NODE_BIN'. It does not use 'tsx', a global package, a stale release pin, or the obsolete pre-cutover phase.

Deploy the complete release build, including 'dist', 'node_modules' production dependencies, and Python helper source. One scheduler owns each connector. Do not overlap old and new binaries.

## Durable media rollups

When 'MEMORY_INGESTION_QUEUE_ENABLED=true', connector rollup atomically:

1. inserts an unembedded 'media_rollup' memory;
2. inserts its exact normal-scope ingestion job using the active embedding profile;
3. links the source media event to that memory.

A failure rolls back all three. The dedicated ingestion worker performs local Qwen inference, updates the compatibility vector, publishes the current local manifest, and marks the job ready. Connector containers no longer need direct embedding network access. Queue-disabled deployments retain the legacy synchronous path.

Acceptance requires the connector result, queued job completion, current manifest/revision, active local contract and a positive media search result. A successful connector exit alone is not readiness proof.

## YouTube Music Python on Fuego

The slim Dappnode Node container intentionally has no Python. Do not point 'YTMUSIC_PYTHON' at a Fuego filesystem path; that path cannot exist inside the container.

1. Build/deploy this release on Fuego.
2. Retain the existing Fuego virtualenv only after verifying it imports 'ytmusicapi'; do not download a model or add Python to the Dappnode image.
3. Install the helper gateway env/service on Fuego. Use a private address, a certificate valid for the endpoint hostname, a mode-0600 private key/env file and a dedicated random bearer token.
4. Firewall port 3011 to the Dappnode source address/private network. Never expose it through public ingress.
5. On the connector worker set:
   - 'YTMUSIC_HELPER_ENDPOINT=https://<private-fuego-name>:3011/v1/ytmusic/fetch'
   - 'YTMUSIC_HELPER_API_KEY=<dedicated-helper-token>'
   - 'NODE_EXTRA_CA_CERTS=<mounted-private-CA-file>' when the certificate is not publicly trusted.
6. Remove the unusable container 'YTMUSIC_PYTHON=/home/fuego/...' override after the endpoint is configured. Endpoint mode takes precedence but stale misleading configuration should not remain.
7. Smoke test health and one bounded sync from the Dappnode worker, then verify credential refresh persistence without printing token/header content.

The gateway accepts only authenticated 'fetch', bounds request/output/time, executes the reviewed release helper with the configured Fuego Python, uses a private mode-0600 temporary token file, and removes it after every request. Interactive auth remains local/operator-run and is deliberately unavailable remotely.

## Runtime prerequisites

- Current release schema including ingestion migrations 049-053.
- Queue gate enabled and healthy dedicated ingestion worker.
- Active local Qwen contract and its existing resource guards.
- Exact connector API key attribution and 'media' namespace.
- Connector-specific credentials already stored through the existing encrypted store.
- 'MEDIA_TIME_ZONE' identical across connector owners.
- For browser history, an explicitly selected profile/database mounted on the execution host; no generic activity rollup exists.
- Parent-owned scheduler cutover, TLS/firewall, secrets and live verification.
