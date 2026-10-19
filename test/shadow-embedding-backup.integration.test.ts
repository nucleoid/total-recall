import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const url=process.env.SHADOW_EMBEDDING_TEST_DATABASE_URL;
test('backup receipt SQL preserves role booleans and fingerprints boolean rows', {skip:!url}, async()=>{
  assert.equal(new URL(url!).pathname,'/total_recall_reembedding_test');
  const pool=new pg.Pool({connectionString:url,max:1});const client=await pool.connect();
  try{
    const role=(await client.query(`SELECT format('ALTER ROLE %I WITH %s %s %s %s %s %s %s CONNECTION LIMIT %s VALID UNTIL %L;',rolname,
      CASE WHEN rolsuper THEN 'SUPERUSER' ELSE 'NOSUPERUSER' END,CASE WHEN rolinherit THEN 'INHERIT' ELSE 'NOINHERIT' END,
      CASE WHEN rolcreaterole THEN 'CREATEROLE' ELSE 'NOCREATEROLE' END,CASE WHEN rolcreatedb THEN 'CREATEDB' ELSE 'NOCREATEDB' END,
      CASE WHEN rolcanlogin THEN 'LOGIN' ELSE 'NOLOGIN' END,CASE WHEN rolreplication THEN 'REPLICATION' ELSE 'NOREPLICATION' END,
      CASE WHEN rolbypassrls THEN 'BYPASSRLS' ELSE 'NOBYPASSRLS' END,rolconnlimit,COALESCE(rolvaliduntil::text,'infinity')) statement
      FROM pg_roles WHERE rolname='total_recall_app'`)).rows[0].statement as string;
    assert.match(role,/ALTER ROLE total_recall_app WITH (?:NO)?SUPERUSER (?:NO)?INHERIT/);
    assert.doesNotMatch(role,/\b[tf]\b/);assert.match(role,/CONNECTION LIMIT -?\d+ VALID UNTIL/);

    await client.query('CREATE TEMP TABLE backup_bool_fixture(id integer PRIMARY KEY, enabled boolean NOT NULL)');
    await client.query('INSERT INTO backup_bool_fixture VALUES(1,true),(2,false)');
    const fingerprint=async()=>JSON.stringify((await client.query(`SELECT ((xpath('/row/value/text()',query_to_xml(
      $q$SELECT jsonb_build_object('rows',count(*),'hash_a',COALESCE(sum((('x'||substr(encode(digest(to_jsonb(t)::text,'sha256'),'hex'),1,16))::bit(64)::bigint)::numeric),0),
      'hash_b',COALESCE(sum((('x'||substr(encode(digest(to_jsonb(t)::text,'sha256'),'hex'),17,16))::bit(64)::bigint)::numeric),0)) AS value FROM backup_bool_fixture t$q$,
      false,true,'')))[1]::text)::jsonb value`)).rows[0].value);
    const before=await fingerprint();assert.match(before,/"rows":2/);
    await client.query('UPDATE backup_bool_fixture SET enabled=NOT enabled WHERE id=1');
    assert.notEqual(await fingerprint(),before);
    const metadata=(await client.query(`SELECT current_setting('server_version_num')::integer/10000 major,
      datlocprovider provider,datcollate,datctype FROM pg_database WHERE datname=current_database()`)).rows[0];
    assert.equal(metadata.major,16);assert.equal(typeof metadata.provider,'string');
  }finally{client.release();await pool.end();}
});
