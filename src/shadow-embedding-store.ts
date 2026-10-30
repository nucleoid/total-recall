import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { QWEN_CONTRACT_ID, sha256, validateLocalStoredVector } from './local-embedding-contract.js';
import { validateParentChunkPlan, type ParentChunkPlan } from './embedding-chunks.js';

export const CURRENT_PARENT_ELIGIBILITY = `deleted_at IS NULL AND superseded_at IS NULL
  AND consolidated_into_id IS NULL AND (expires_at IS NULL OR expires_at > statement_timestamp())
  AND (valid_from IS NULL OR valid_from <= statement_timestamp())
  AND (valid_to IS NULL OR valid_to > statement_timestamp())`;

export interface ShadowClaim {
  contractId: string;
  parentType: 'memory' | 'subscription';
  parentId: string;
  generation: string;
  owner: string;
  attempts: number;
}

export interface ClaimedSource {
  text: string;
  revision: number;
  sha256: string;
  eligible: boolean;
  disposition?: 'deleted' | 'superseded' | 'consolidated' | 'expired' | 'future' | 'ended' | 'inactive';
  deferUntil?: Date;
}

/** Operator-only connection; never the application's scoped pool or GPU worker. */
export class ShadowEmbeddingStore {
  readonly owner = randomUUID();
  constructor(private readonly pool: pg.Pool, readonly runId: string, private readonly leaseSeconds = 120,
    readonly mode: 'backfill' | 'steady' = 'backfill') {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 300) throw new Error('embedding.lease_limit');
    if (mode !== 'backfill' && mode !== 'steady') throw new Error('embedding.worker_mode');
  }

  private runFence(runAlias = 'r'): string {
    if (this.mode === 'backfill') return `${runAlias}.status='running'`;
    return `${runAlias}.status IN ('paused','complete')
      AND ${runAlias}.manifest ? 'steadyState' AND ${runAlias}.manifest#>>'{steadyState,runtime,expectedRuntimeMode}'='cpu'
      AND EXISTS (SELECT 1 FROM embedding_serving_settings s
        JOIN embedding_contracts c ON c.id=s.contract_id
        JOIN embedding_cutover_attestations a ON a.contract_id=s.contract_id AND a.run_id=s.cutover_attestation_run_id
        WHERE s.singleton AND s.contract_id=${runAlias}.contract_id AND s.cutover_attestation_run_id=${runAlias}.id
          AND s.capture_required AND c.capture_enabled AND s.steady_worker_enabled)`;
  }

  async verifyDatabase(expectedDatabase: string): Promise<void> {
    const result = await this.pool.query(`SELECT current_database() AS db, r.rolsuper OR r.rolbypassrls AS operator
      FROM pg_roles r WHERE r.rolname = current_user`);
    if (result.rows[0]?.db !== expectedDatabase || result.rows[0]?.operator !== true) throw new Error('embedding.database_identity');
    const run = await this.pool.query('SELECT contract_id FROM embedding_runs WHERE id=$1', [this.runId]);
    if (run.rows[0]?.contract_id !== QWEN_CONTRACT_ID) throw new Error('embedding.run_contract');
  }

  async claim(): Promise<ShadowClaim | null> {
    const result = await this.pool.query(`WITH picked AS (
      SELECT w.contract_id,w.parent_type,w.parent_id FROM embedding_work_items w
      JOIN embedding_runs r ON r.contract_id=w.contract_id AND r.id=$1 AND ${this.runFence()}
      WHERE w.contract_id=$2 AND w.state IN ('pending','retry','claimed')
        AND ((w.state IN ('pending','retry') AND w.next_attempt_at<=statement_timestamp())
        OR (w.state='claimed' AND w.lease_until<statement_timestamp()))
      ORDER BY w.next_attempt_at,w.parent_type,w.parent_id FOR UPDATE OF w SKIP LOCKED LIMIT 1
    ) UPDATE embedding_work_items w SET state='claimed',claimed_by=$3,lease_until=statement_timestamp()+$4*interval '1 second',
      generation=w.generation+1,updated_at=statement_timestamp()
    FROM picked p WHERE w.contract_id=p.contract_id AND w.parent_type=p.parent_type AND w.parent_id=p.parent_id
    RETURNING w.contract_id,w.parent_type,w.parent_id,w.generation::text,w.attempts`,
    [this.runId, QWEN_CONTRACT_ID, this.owner, this.leaseSeconds]);
    const item = result.rows[0];
    return item ? { contractId: item.contract_id, parentType: item.parent_type, parentId: item.parent_id,
      generation: item.generation, owner: this.owner, attempts: item.attempts } : null;
  }

  async loadSource(claim: ShadowClaim): Promise<ClaimedSource | null> {
    const result = claim.parentType === 'memory'
      ? await this.pool.query(`SELECT content AS text,revision,(${CURRENT_PARENT_ELIGIBILITY}) AS eligible,
          CASE WHEN deleted_at IS NOT NULL THEN 'deleted' WHEN superseded_at IS NOT NULL THEN 'superseded'
            WHEN consolidated_into_id IS NOT NULL THEN 'consolidated'
            WHEN expires_at IS NOT NULL AND expires_at<=statement_timestamp() THEN 'expired'
            WHEN valid_to IS NOT NULL AND valid_to<=statement_timestamp() THEN 'ended'
            WHEN valid_from IS NOT NULL AND valid_from>statement_timestamp() THEN 'future' END AS disposition,
          CASE WHEN valid_from>statement_timestamp()
            AND (expires_at IS NULL OR valid_from<expires_at) AND (valid_to IS NULL OR valid_from<valid_to)
            THEN valid_from END AS defer_until FROM memories WHERE id=$1`, [claim.parentId])
      : await this.pool.query(`SELECT query_text AS text,0 AS revision,status='active' AS eligible,
          CASE WHEN status<>'active' THEN 'inactive' END AS disposition FROM memory_subscriptions WHERE id=$1`, [claim.parentId]);
    const row = result.rows[0];
    return row ? { text: row.text, revision: row.revision, sha256: sha256(row.text), eligible: row.eligible,
      disposition: row.disposition, deferUntil: row.defer_until } : null;
  }

  async renew(claim: ShadowClaim): Promise<boolean> {
    const result = await this.pool.query(`UPDATE embedding_work_items w SET
      lease_until=statement_timestamp()+$6*interval '1 second',updated_at=statement_timestamp()
      WHERE contract_id=$1 AND parent_type=$2 AND parent_id=$3 AND generation=$4 AND claimed_by=$5
        AND state='claimed' AND lease_until>statement_timestamp()
        AND EXISTS (SELECT 1 FROM embedding_runs r WHERE r.id=$7 AND r.contract_id=w.contract_id AND ${this.runFence()})`,
    [claim.contractId, claim.parentType, claim.parentId, claim.generation, claim.owner, this.leaseSeconds, this.runId]);
    return result.rowCount === 1;
  }

  async settle(claim: ShadowClaim, state: 'retry' | 'failed' | 'excluded', errorCode: string, delayMs = 0): Promise<boolean> {
    if (!/^[a-z0-9_.]{1,96}$/u.test(errorCode) || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 300_000) {
      throw new Error('embedding.invalid_error_state');
    }
    const result = await this.pool.query(`UPDATE embedding_work_items SET state=$6,error_code=$7,
      attempts=attempts+CASE WHEN $6='retry' OR $7='embedding.retry_exhausted' THEN 1 ELSE 0 END,
      next_attempt_at=statement_timestamp()+$8*interval '1 millisecond',claimed_by=NULL,lease_until=NULL,updated_at=statement_timestamp()
      WHERE contract_id=$1 AND parent_type=$2 AND parent_id=$3 AND generation=$4 AND claimed_by=$5
        AND state='claimed' AND lease_until>statement_timestamp()`,
    [claim.contractId, claim.parentType, claim.parentId, claim.generation, claim.owner, state, errorCode, delayMs]);
    return result.rowCount === 1;
  }

  /** Release sound work without charging a failure attempt (future activation or a finite batch boundary). */
  async defer(claim: ShadowClaim, errorCode: string, until = new Date()): Promise<boolean> {
    if (!/^[a-z0-9_.]{1,96}$/u.test(errorCode) || !(until instanceof Date) || !Number.isFinite(until.getTime())) {
      throw new Error('embedding.invalid_error_state');
    }
    const result = await this.pool.query(`UPDATE embedding_work_items SET state='retry',error_code=$6,
      next_attempt_at=GREATEST($7::timestamptz,statement_timestamp()),claimed_by=NULL,lease_until=NULL,
      updated_at=statement_timestamp()
      WHERE contract_id=$1 AND parent_type=$2 AND parent_id=$3 AND generation=$4 AND claimed_by=$5
        AND state='claimed' AND lease_until>statement_timestamp()`,
    [claim.contractId, claim.parentType, claim.parentId, claim.generation, claim.owner, errorCode, until]);
    return result.rowCount === 1;
  }

  async pause(errorCode: string): Promise<void> {
    if (!/^[a-z0-9_.]{1,96}$/u.test(errorCode)) throw new Error('embedding.invalid_error_state');
    if (this.mode === 'steady') {
      const client=await this.pool.connect();try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'");
        const run=await client.query(`SELECT 1 FROM embedding_runs r WHERE r.id=$1 AND r.contract_id=$2 AND ${this.runFence()} FOR UPDATE`,
        [this.runId,QWEN_CONTRACT_ID]);
        if(run.rowCount===1)await client.query(`UPDATE embedding_serving_settings SET steady_worker_enabled=false,steady_worker_last_error=$2,
          updated_at=statement_timestamp() WHERE singleton AND contract_id=$3 AND cutover_attestation_run_id=$1`,
        [this.runId,errorCode,QWEN_CONTRACT_ID]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    } else await this.pool.query(`UPDATE embedding_runs SET status='paused',last_error_code=$2,updated_at=statement_timestamp()
      WHERE id=$1 AND contract_id=$3 AND status='running'`, [this.runId, errorCode, QWEN_CONTRACT_ID]);
  }

  async commitMemory(claim: ShadowClaim, source: ClaimedSource, plan: ParentChunkPlan, vectors: number[][]): Promise<boolean> {
    if (claim.parentType !== 'memory' || claim.contractId !== QWEN_CONTRACT_ID) throw new Error('embedding.claim_contract');
    validateParentChunkPlan(source.text, plan);
    if (vectors.length !== plan.chunks.length || source.sha256 !== plan.sourceSha256) throw new Error('embedding.commit_shape');
    vectors.forEach(validateLocalStoredVector);
    return this.commit(claim, source, async client => {
      await client.query(`INSERT INTO memory_embedding_manifests(contract_id,parent_id,source_sha256,source_revision,
        source_bytes,chunk_count,total_tokens,is_current) VALUES($1,$2,$3,$4,$5,$6,$7,false)
        ON CONFLICT(contract_id,parent_id) DO UPDATE SET source_sha256=EXCLUDED.source_sha256,source_revision=EXCLUDED.source_revision,
        source_bytes=EXCLUDED.source_bytes,chunk_count=EXCLUDED.chunk_count,total_tokens=EXCLUDED.total_tokens,is_current=false`,
      [claim.contractId, claim.parentId, source.sha256, source.revision, plan.sourceBytes, plan.chunks.length,
        plan.chunks.reduce((n, c) => n + c.tokens, 0)]);
      await client.query('DELETE FROM memory_embedding_chunks WHERE contract_id=$1 AND parent_id=$2', [claim.contractId, claim.parentId]);
      for (let i = 0; i < plan.chunks.length; i++) {
        const c = plan.chunks[i];
        await client.query(`INSERT INTO memory_embedding_chunks(contract_id,parent_id,ordinal,core_start,core_end,chunk_sha256,formatted_tokens,embedding)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::vector)`,
        [claim.contractId, claim.parentId, c.ordinal, c.coreStart, c.coreEnd, c.sha256, c.tokens, `[${vectors[i].join(',')}]`]);
      }
      await client.query(`UPDATE memory_embedding_manifests SET is_current=true,committed_at=statement_timestamp()
        WHERE contract_id=$1 AND parent_id=$2`, [claim.contractId, claim.parentId]);
    });
  }

  async commitSubscription(claim: ShadowClaim, source: ClaimedSource, vector: number[], tokens: number): Promise<boolean> {
    if (claim.parentType !== 'subscription' || claim.contractId !== QWEN_CONTRACT_ID
      || !Number.isSafeInteger(tokens) || tokens < 0 || tokens > 2000) throw new Error('embedding.subscription_shape');
    validateLocalStoredVector(vector);
    return this.commit(claim, source, async client => {
      await client.query(`INSERT INTO subscription_embedding_targets(contract_id,subscription_id,source_sha256,formatted_tokens,embedding)
        VALUES($1,$2,$3,$4,$5::vector) ON CONFLICT(contract_id,subscription_id) DO UPDATE SET
        source_sha256=EXCLUDED.source_sha256,formatted_tokens=EXCLUDED.formatted_tokens,embedding=EXCLUDED.embedding,
        committed_at=statement_timestamp()`, [claim.contractId, claim.parentId, source.sha256, tokens, `[${vector.join(',')}]`]);
    });
  }

  private async commit(claim: ShadowClaim, source: ClaimedSource, write: (client: pg.PoolClient) => Promise<void>): Promise<boolean> {
    const client = await this.pool.connect();
    let inTransaction = false;
    let discard: Error | undefined;
    try {
      await client.query('BEGIN'); inTransaction = true;
      await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'");
      // Lock parent before queue, matching transactional mutation-trigger order.
      const current = claim.parentType === 'memory'
        ? await client.query(`SELECT content AS text,revision,(${CURRENT_PARENT_ELIGIBILITY}) AS eligible FROM memories WHERE id=$1 FOR SHARE`, [claim.parentId])
        : await client.query(`SELECT query_text AS text,0 AS revision,status='active' AS eligible FROM memory_subscriptions WHERE id=$1 FOR SHARE`, [claim.parentId]);
      const row = current.rows[0];
      if (!row?.eligible || row.revision !== source.revision || sha256(row.text) !== source.sha256) {
        await client.query('ROLLBACK'); inTransaction = false; return false;
      }
      if (this.mode === 'steady') {
        const run=await client.query(`SELECT 1 FROM embedding_runs r WHERE r.id=$1 AND r.contract_id=$2
          AND r.status IN ('paused','complete') AND r.manifest ? 'steadyState'
          AND r.manifest#>>'{steadyState,runtime,expectedRuntimeMode}'='cpu' FOR SHARE`,[this.runId,claim.contractId]);
        if(!run.rowCount){await client.query('ROLLBACK');inTransaction=false;return false;}
        const control=await client.query(`SELECT 1 FROM embedding_serving_settings s
          JOIN embedding_contracts c ON c.id=s.contract_id
          JOIN embedding_cutover_attestations a ON a.contract_id=s.contract_id AND a.run_id=s.cutover_attestation_run_id
          WHERE s.singleton AND s.contract_id=$1 AND s.cutover_attestation_run_id=$2 AND s.capture_required
            AND c.capture_enabled AND s.steady_worker_enabled FOR SHARE OF s,c`,[claim.contractId,this.runId]);
        if(!control.rowCount){await client.query('ROLLBACK');inTransaction=false;return false;}
      } else {
        const run=await client.query(`SELECT 1 FROM embedding_runs r WHERE r.id=$1 AND r.contract_id=$2
          AND r.status='running' FOR SHARE`,[this.runId,claim.contractId]);
        if(!run.rowCount){await client.query('ROLLBACK');inTransaction=false;return false;}
      }
      const fence = await client.query(`SELECT 1 FROM embedding_work_items w
        WHERE contract_id=$1 AND parent_type=$2 AND parent_id=$3 AND generation=$4 AND claimed_by=$5
          AND state='claimed' AND lease_until>statement_timestamp()
          AND EXISTS (SELECT 1 FROM embedding_runs r WHERE r.id=$6 AND r.contract_id=w.contract_id AND ${this.runFence()})
        FOR UPDATE`, [claim.contractId, claim.parentType, claim.parentId, claim.generation, claim.owner, this.runId]);
      if (!fence.rowCount) { await client.query('ROLLBACK'); inTransaction = false; return false; }
      await write(client);
      await client.query(`UPDATE embedding_work_items SET state='complete',source_sha256=$6,source_revision=$7,
        claimed_by=NULL,lease_until=NULL,error_code=NULL,updated_at=statement_timestamp()
        WHERE contract_id=$1 AND parent_type=$2 AND parent_id=$3 AND generation=$4 AND claimed_by=$5`,
      [claim.contractId, claim.parentType, claim.parentId, claim.generation, claim.owner, source.sha256, source.revision]);
      await client.query('COMMIT'); inTransaction = false; return true;
    } catch (error) {
      if (inTransaction) {
        try { await client.query('ROLLBACK'); } catch { discard = new Error('embedding.rollback_connection'); }
      } else discard = new Error('embedding.commit_connection');
      throw error;
    } finally { client.release(discard); }
  }
}
