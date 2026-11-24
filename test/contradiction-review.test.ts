import assert from 'node:assert/strict';import test from 'node:test';
import {assertContradictionReviewerAuthority,createContradictionDecision,type ContradictionReviewReceipt} from '../src/contradiction-review.js';
import {contradictionPolicyFromEnv} from '../src/contradictions.js';import {parseContradictionReviewCli} from '../scripts/contradiction-review.js';
const env={CONTRADICTION_CLASSIFICATION_ENABLED:'true',CONTRADICTION_PROCESSING_APPROVED:'true',CONTRADICTION_PROVIDER:'openclaw-adapter',
 CONTRADICTION_MODEL:'openclaw/total-recall-synthesis',CONTRADICTION_GENERATION_ENDPOINT:'https://example.test',CONTRADICTION_PROVIDER_MODEL_APPROVED:'true',
 CONTRADICTION_PRIVACY_APPROVED:'true',CONTRADICTION_RETENTION_APPROVED:'true',CONTRADICTION_TRAINING_APPROVED:'true',CONTRADICTION_APPROVED_NAMESPACE:'my-life',
 CONTRADICTION_APPROVED_ACCESS_LEVEL:'secret',CONTRADICTION_SCOPE_APPROVED:'true',CONTRADICTION_BUDGET_MODE:'subscription',CONTRADICTION_BUDGET_APPROVED:'true',
 CONTRADICTION_MAX_CALLS_PER_INVOCATION:'1',CONTRADICTION_MAX_INPUT_BYTES_PER_INVOCATION:'65536',CONTRADICTION_MAX_OUTPUT_BYTES_PER_INVOCATION:'1024',
 CONTRADICTION_USAGE_CONTROL_REFERENCE:'test'};
test('reviewer authority is dedicated and CLI bounds exact sources',()=>{const policy=contradictionPolicyFromEnv(env);const auth={keyId:'00000000-0000-4000-8000-000000000001',name:'r',namespaces:['my-life'],permissions:['read','contradiction_resolve'],maxAccessLevel:'secret' as const};
 assert.doesNotThrow(()=>assertContradictionReviewerAuthority(auth,policy));assert.throws(()=>assertContradictionReviewerAuthority({...auth,permissions:[...auth.permissions,'write']},policy),/without write/);
 assert.deepEqual(parseContradictionReviewCli(['preview','--subject',auth.keyId,'--candidate','00000000-0000-4000-8000-000000000002','--output','r.json']).mode,'preview');});
test('decision creation requires a valid immutable receipt fingerprint',()=>{const receipt={version:1,feature:'contradiction-reviewed-resolution',environment:'test',createdAt:'2026-11-24T00:00:00.000Z',namespace:'my-life',accessLevel:'secret',subjectId:'00000000-0000-4000-8000-000000000001',promptSources:[],classification:{classification:'contradiction',confidence:1,candidate_id:'00000000-0000-4000-8000-000000000002'},policyFingerprint:'x',receiptFingerprint:'0'.repeat(64)} as ContradictionReviewReceipt;
 assert.throws(()=>createContradictionDecision(receipt,{decision:'apply',approvedBy:'owner',approvedAt:'2026-11-24T00:00:00Z',expiresAt:'2026-11-25T00:00:00Z'}),/receipt/);});
