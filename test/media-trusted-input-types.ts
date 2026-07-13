import type { TrustedMediaEventInput } from '../src/media.js';

// @ts-expect-error Trusted persistence requires server-derived client_id.
const missingClientId: TrustedMediaEventInput = {
  service: 'spotify',
  event_type: 'play',
  title: 'Song',
  played_at: '2026-07-11T01:02:03Z',
};

void missingClientId;
