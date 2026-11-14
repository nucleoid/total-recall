import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { LocalEmbeddingGateway, verifyGatewayReceipt, type GatewayReceipt } from '../src/local-embedding-gateway.js';
import {verifyWindowsEmbeddingPermissions} from '../src/windows-embedding-permissions.js';

function integer(name:string,min:number,max:number):number{const raw=process.env[name];if(!raw||!/^\d+$/.test(raw))throw new Error(`gateway.${name.toLowerCase()}`);const n=Number(raw);if(n<min||n>max)throw new Error(`gateway.${name.toLowerCase()}`);return n;}

async function main(){
  const configPath=process.env.SHADOW_EMBEDDING_GATEWAY_CONFIG;
  const secretPath=process.env.SHADOW_EMBEDDING_GATEWAY_KEY_FILE;
  const expectedConfigSha=process.env.SHADOW_EMBEDDING_GATEWAY_CONFIG_SHA256;
  if(!configPath||!secretPath||!/^[a-f0-9]{64}$/.test(expectedConfigSha??''))throw new Error('gateway.configuration_required');
  const fs=await import('node:fs/promises'),[keyStat,configStat]=await Promise.all([fs.stat(secretPath),fs.stat(configPath)]);
  if(process.platform!=='win32'&&(keyStat.mode&0o077)!==0)throw new Error('gateway.secret_permissions');
  if(process.platform!=='win32'&&(configStat.mode&0o077)!==0)throw new Error('gateway.config_permissions');
  if(process.platform==='win32')await verifyWindowsEmbeddingPermissions([secretPath,configPath],true);
  const config=await readFile(configPath);if(createHash('sha256').update(config).digest('hex')!==expectedConfigSha)throw new Error('gateway.config_identity');
  const receipt=await verifyGatewayReceipt(JSON.parse(config.toString('utf8')) as GatewayReceipt);
  const secret=Buffer.from((await readFile(secretPath,'utf8')).trim(),'utf8');
  const gateway=new LocalEmbeddingGateway(receipt,secret,integer('SHADOW_EMBEDDING_BACKEND_PORT',1024,65535));
  const stop=async()=>{await gateway.close();process.exitCode=0;};
  process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
  await gateway.start();
}
main().catch(()=>{process.exitCode=1;});
