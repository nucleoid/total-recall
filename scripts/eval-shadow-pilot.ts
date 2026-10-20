import 'dotenv/config';
import {open,readFile,stat,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {evaluateShadowPilot,PILOT_INPUT_MAX_BYTES,type PilotApproval,type PilotInput} from '../src/shadow-embedding-quality.js';

function flag(args:string[],name:string):string|undefined{const i=args.indexOf(name);return i<0?undefined:args[i+1];}
async function main(){
  const args=process.argv.slice(2),input=flag(args,'--input'),output=flag(args,'--output'),corpus=flag(args,'--expected-corpus-hash'),judgments=flag(args,'--expected-judgments-hash'),baseline=flag(args,'--baseline-receipt-sha256'),reference=flag(args,'--approval-reference'),keyFile=flag(args,'--pseudonym-key-file'),durationRaw=flag(args,'--max-duration-ms');
  const known=new Set(['--input','--output','--expected-corpus-hash','--expected-judgments-hash','--baseline-receipt-sha256','--approval-reference','--pseudonym-key-file','--max-duration-ms']);
  if(!input||!output||!corpus||!judgments||!baseline||!reference||!keyFile||args.length!==(durationRaw===undefined?14:16)||args.some((v,i)=>i%2===0&&!known.has(v)))throw new Error('usage: --input FILE --output FILE --expected-corpus-hash SHA256 --expected-judgments-hash SHA256 --baseline-receipt-sha256 SHA256 --approval-reference REF --pseudonym-key-file FILE [--max-duration-ms 120000..900000]');
  const keyPath=resolve(keyFile),keyStat=await stat(keyPath);if(process.platform!=='win32'&&(keyStat.mode&0o077)!==0)throw new Error('pilot.pseudonym_key_permissions');
  const maxDurationMs=durationRaw===undefined?undefined:Number(durationRaw);if(durationRaw!==undefined&&!/^\d+$/.test(durationRaw))throw new Error('pilot.max_duration');
  const approval:PilotApproval={expectedCorpusHash:corpus,expectedJudgmentsHash:judgments,baselineReceiptSha256:baseline,approvalReference:reference,...(maxDurationMs===undefined?{}:{maxDurationMs})};
  const handle=await open(resolve(input),'r');let inputBytes:Buffer;try{const info=await handle.stat();if(!info.isFile()||info.size<1||info.size>PILOT_INPUT_MAX_BYTES)throw new Error('pilot.input_byte_budget');inputBytes=await handle.readFile();if(inputBytes.length!==info.size||inputBytes.length>PILOT_INPUT_MAX_BYTES)throw new Error('pilot.input_changed');}finally{await handle.close();}
  const report=await evaluateShadowPilot(JSON.parse(inputBytes.toString('utf8')) as PilotInput,approval,await readFile(keyPath));
  await writeFile(resolve(output),`${JSON.stringify(report,null,2)}\n`,{flag:'wx',mode:0o600});if(!report.passed)process.exitCode=2;
}
main().catch(error=>{process.stderr.write(`Shadow pilot failed: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
