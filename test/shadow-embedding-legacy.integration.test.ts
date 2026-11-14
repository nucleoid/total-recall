import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { QWEN_CONTRACT_ID, sha256 } from '../src/local-embedding-contract.js';

const url = process.env.SHADOW_EMBEDDING_TEST_DATABASE_URL;
test('scalar compatibility mutations retain labelled and unlabelled legacy coordinates privately', { skip: !url }, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const db = await pool.connect();
  try {
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, 'total_recall_reembedding_test');
    await db.query('BEGIN');
    const unit = `[1,${Array(767).fill(0).join(',')}]`;
    for (const labelled of [true, false]) {
      const id = randomUUID();
      await db.query(`INSERT INTO memories(id,content,source,namespace,client_id,embedding,embedding_provider,embedding_model,embedding_dimensions)
        VALUES($1,'original synthetic source','test','personal','test',$2::vector,$3,$4,$5)`,
      [id, unit, labelled ? 'gemini' : null, labelled ? 'gemini-embedding-2-preview' : null, labelled ? 768 : null]);
      await db.query(`UPDATE memories SET content='edited synthetic source',embedding=$2::vector,
        embedding_provider='llama.cpp',embedding_model=$3,embedding_dimensions=768 WHERE id=$1`, [id, unit, QWEN_CONTRACT_ID]);
      const rows = (await db.query(`SELECT source_sha256,embedding_provider,embedding_model,embedding_dimensions,
        embedding::text AS vector FROM legacy_embedding_vector_archive WHERE parent_type='memory' AND parent_id=$1`, [id])).rows;
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], { source_sha256: sha256('original synthetic source'), embedding_provider: labelled ? 'gemini' : null,
        embedding_model: labelled ? 'gemini-embedding-2-preview' : null, embedding_dimensions: labelled ? 768 : null, vector: unit });
      assert.equal((await db.query(`SELECT has_table_privilege('total_recall_app','legacy_embedding_vector_archive','SELECT') AS readable`)).rows[0].readable, false);
    }
  } finally {
    await db.query('ROLLBACK'); db.release(); await pool.end();
  }
});
