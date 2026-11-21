import {readFile,statfs,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {fetchBeaconHealth} from './beacon-health.js';
export function readySample(s){return Number.isFinite(s.availableBytes)&&s.availableBytes>=25769803776&&Number.isFinite(s.diskFreeBytes)&&s.diskFreeBytes>=268435456000&&Number.isFinite(s.cpuPsi)&&s.cpuPsi>=0&&s.cpuPsi<10&&Number.isFinite(s.memoryPsi)&&s.memoryPsi>=0&&s.memoryPsi<1&&s.eth?.is_syncing===false&&s.eth?.is_optimistic===false&&s.eth?.el_offline===false&&Number(s.eth?.sync_distance)===0;}
export async function waitUntilReady({sample,now=Date.now,sleep=delay,stableMs=60000,deadlineMs=1800000,record=async()=>{}}){let since=null;const start=now();while(now()-start<deadlineMs){let s;try{s=await sample();}catch{s=null;}if(s&&readySample(s)){since??=now();if(now()-since>=stableMs){await record({state:'passed',healthySeconds:stableMs/1000,sample:s});return;}}else since=null;await sleep(2000);}await record({state:'failed_deadline'});throw Error('startup.readiness_deadline');}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1]){
 const state=process.argv[2];if(!state?.startsWith('/'))throw Error('startup.receipt_path');
 const sample=async()=>{const [mem,cpu,memory,disk,eth]=await Promise.all([readFile('/proc/meminfo','utf8'),readFile('/proc/pressure/cpu','utf8'),readFile('/proc/pressure/memory','utf8'),statfs(state.slice(0,state.lastIndexOf('/'))),fetchBeaconHealth()]);return {availableBytes:Number(/^MemAvailable:\s+(\d+)/m.exec(mem)?.[1])*1024,diskFreeBytes:Number(disk.bavail)*Number(disk.bsize),cpuPsi:Number(/^some avg10=([0-9.]+)/m.exec(cpu)?.[1]),memoryPsi:Number(/^some avg10=([0-9.]+)/m.exec(memory)?.[1]),eth};};
 await waitUntilReady({sample,deadlineMs:Number.POSITIVE_INFINITY,record:r=>writeFile(state,JSON.stringify({at:new Date().toISOString(),...r}),{mode:0o600})});
}
