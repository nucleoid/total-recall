import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  fingerprintRepairCandidate,
  validateApprovalManifest,
  type ApprovalManifest,
} from '../scripts/repair-relevance-scores.js';

const fingerprint = 'a'.repeat(64);
const base: ApprovalManifest = {
  backupVerified: true,
  approvals: [{ id: '00000000-0000-4000-8000-000000000001', fingerprint, action: 'reset-managed' }],
};

test('repair requires backup acknowledgement and exact per-row approvals', () => {
  assert.throws(() => validateApprovalManifest({ ...base, backupVerified: false }), /backup/i);
  assert.throws(() => validateApprovalManifest({
    backupVerified: true,
    approvals: [{ ...base.approvals[0], id: '*' }],
  }), /UUID/i);
  assert.throws(() => validateApprovalManifest({
    backupVerified: true,
    approvals: [base.approvals[0], base.approvals[0]],
  }), /duplicate/i);
});

test('repair fingerprints are computed in Node without a pgcrypto prerequisite', async () => {
  const candidate = {
    id: '00000000-0000-4000-8000-000000000001',
    namespace: 'personal',
    relevance_score: 1.25,
    decay_rate: 0.01,
    accessed_at: new Date('2026-01-02T03:04:05.000Z'),
    access_count: 7,
    updated_at: null,
  };

  assert.equal(fingerprintRepairCandidate(candidate), 'ee8c2174780fad9f1742ce359f83f166296b63ecd6965d03ccbb35a2fa4c3515');
  const source = await readFile(new URL('../scripts/repair-relevance-scores.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /encode\s*\(\s*digest/i);
  assert.doesNotMatch(source, /pgcrypto/i);
});

test('an empty exact manifest is valid only as a database-proven finalize request', () => {
  const manifest = validateApprovalManifest({ backupVerified: true, approvals: [] });
  assert.deepEqual(manifest.approvals, []);
});

test('runbook requires the strict recall-freeze maintenance sequence', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /freeze (?:search and )?recall/i);
  assert.match(readme, /fresh preview/i);
  assert.match(readme, /verify[\s\S]{0,120}(?:resume|before resuming)/i);
  assert.match(readme, /MAINTENANCE_DATABASE_URL/);
  assert.match(readme, /MIGRATION_DATABASE_URL[\s\S]{0,80}fallback/i);
  assert.match(readme, /decay[\s\S]{0,120}(?:abort|fail|refuse)[\s\S]{0,120}unclassified/i);
});

test('custom preservation accepts only independently supplied finite nonnegative bases', () => {
  for (const value of [Number.NaN, Infinity, -1]) {
    assert.throws(() => validateApprovalManifest({
      backupVerified: true,
      approvals: [{ ...base.approvals[0], action: 'preserve-custom', baseScore: value }],
    }), /base/i);
  }
  const valid = validateApprovalManifest({
    backupVerified: true,
    approvals: [{ ...base.approvals[0], action: 'preserve-custom', baseScore: 2.5 }],
  });
  assert.equal(valid.approvals[0].baseScore, 2.5);
});
