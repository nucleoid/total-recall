import {randomBytes} from 'node:crypto';
import type {Pool} from 'pg';
import {authContextFromRow,canAccessLevel,hashKey} from '../auth.js';
import {assertSafeSyncRole,syncAuth} from './sync-store.js';
import {archiveIdSchema,SYNC_NAMESPACE} from './sync-format.js';

/** Operator-only provisioning. No usable bearer secret is returned or retained. */
export async function provisionArchiveSync(pool:Pool,archiveId:string,readerIds:string[]){
  archiveIdSchema.parse(archiveId);
  if(!readerIds.length||readerIds.length>32||new Set(readerIds).size!==readerIds.length||
    readerIds.some(id=>!/^[-a-f0-9]{36}$/i.test(id)))throw new Error('archive_sync.reader_ids_required');
  const client=await pool.connect();
  try{
    await assertSafeSyncRole(client);await client.query('begin');
    await client.query("set local lock_timeout='5s'");
    const name=`my-life-sync:${archiveId}`;
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`api-key-name:${name}`]);
    const readers=(await client.query(`select id,name,namespaces,permissions,max_access_level,requests_per_minute,requests_per_day,expires_at
      from api_keys where id=any($1::uuid[]) and enabled and revoked_at is null
        and (expires_at is null or expires_at>now()) order by id for update`,[readerIds])).rows;
    if(readers.length!==readerIds.length||readers.some(row=>{
      const auth=authContextFromRow(row);
      return !auth||!auth.namespaces.includes('personal')||!auth.permissions.includes('read')||!canAccessLevel('sensitive',auth.maxAccessLevel);
    }))throw new Error('archive_sync.reader_not_personal');
    const existing=(await client.query('select id,enabled,revoked_at from api_keys where name=$1 order by created_at',[name])).rows;
    if(existing.length>1)throw new Error('archive_sync.ambiguous_identity');
    let keyId:string;
    if(existing.length){
      if(!existing[0].enabled||existing[0].revoked_at)throw new Error('archive_sync.identity_requires_operator_recovery');
      keyId=existing[0].id;await syncAuth(client,keyId);
    }
    else keyId=(await client.query(`insert into api_keys(key_hash,name,namespaces,permissions,max_access_level)
      values($1,$2,array['my-life'],array['read','write','import'],'sensitive') returning id`,
      [hashKey(randomBytes(32).toString('hex')),name])).rows[0].id;
    await client.query(`update api_keys set namespaces=array_append(namespaces,$2)
      where id=any($1::uuid[]) and not ($2=any(namespaces))`,[readerIds,SYNC_NAMESPACE]);
    await client.query('commit');
    return {event:'archive_sync.provisioned',archive_id:archiveId,sync_key_id:keyId,
      reader_keys:readers.map(row=>({id:row.id,name:row.name})),namespace:SYNC_NAMESPACE,access_level:'sensitive'};
  }catch(error){await client.query('rollback').catch(()=>{});throw error;}
  finally{client.release();}
}
