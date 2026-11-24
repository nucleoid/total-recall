import { readFileSync } from 'node:fs';
import { createYtmusicHelperGateway } from './ytmusic-helper-gateway.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + ' is required');
  return value;
};
const integer = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(name + ' is invalid');
  return Number(raw);
};
const host = required('YTMUSIC_HELPER_HOST');
const port = integer('YTMUSIC_HELPER_PORT', 3011, 1, 65535);
const server = createYtmusicHelperGateway({
  host, port,
  bearerToken: required('YTMUSIC_HELPER_BEARER_TOKEN'),
  python: required('YTMUSIC_HELPER_PYTHON'),
  helper: required('YTMUSIC_HELPER_SCRIPT'),
  tls: {
    cert: readFileSync(required('YTMUSIC_HELPER_TLS_CERT')),
    key: readFileSync(required('YTMUSIC_HELPER_TLS_KEY')),
  },
  timeoutMs: integer('YTMUSIC_HELPER_TIMEOUT_MS', 60000, 1000, 120000),
  maxRequestBytes: integer('YTMUSIC_HELPER_MAX_REQUEST_BYTES', 262144, 1024, 1048576),
  maxResponseBytes: integer('YTMUSIC_HELPER_MAX_RESPONSE_BYTES', 2097152, 1024, 4194304),
});
server.listen(port, host, () => console.log('[ytmusic-helper] listening on ' + host + ':' + port));
const stop = () => server.close();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
