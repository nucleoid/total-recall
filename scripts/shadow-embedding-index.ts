import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateOperationalManifest } from '../src/shadow-embedding-control.js';
import { buildShadowIndex, completeShadowRun, inspectShadowIndex } from '../src/shadow-embedding-index.js';
import { activateCutover, attestCutover, rollbackCutover, validateCutoverPlan } from '../src/shadow-embedding-cutover.js';

export function parseShadowIndexArguments(argv: string[]) {
  const command = argv.shift();
  if (!['inspect','build','attest-cutover','activate','rollback','complete'].includes(command ?? '')) throw new Error('embedding.index_command');
  const values = new Map<string,string>(); let apply=false;
  for (let i=0;i<argv.length;i++) {
    const flag=argv[i];
    if (flag==='--apply') { if (apply) throw new Error('embedding.duplicate_argument'); apply=true; continue; }
    if (!['--database','--run-id','--manifest','--manifest-sha256','--attestation','--cutover-watermark','--cutover-plan','--cutover-plan-sha256','--reason','--rollback-evidence-sha256'].includes(flag)
      || values.has(flag)) throw new Error('embedding.unknown_argument');
    const value=argv[++i]; if (!value || value.startsWith('--')) throw new Error('embedding.argument_value_required'); values.set(flag,value);
  }
  const database=values.get('--database'); if (!database?.trim()) throw new Error('embedding.expected_database_required');
  if (command!=='inspect' && !apply) throw new Error('embedding.apply_required');
  if (command!=='inspect' && ['--run-id','--manifest','--manifest-sha256'].some(flag=>!values.get(flag))) throw new Error('embedding.approved_manifest_required');
  if (command==='complete' && (!values.get('--attestation') || !values.get('--cutover-watermark'))) throw new Error('embedding.completion_attestation');
  if (command!=='complete' && (values.has('--attestation') || values.has('--cutover-watermark'))) throw new Error('embedding.completion_arguments');
  if (['attest-cutover','activate','rollback'].includes(command!) && (!values.get('--cutover-plan')||!values.get('--cutover-plan-sha256'))) throw new Error('embedding.cutover_plan_required');
  if (!['attest-cutover','activate','rollback'].includes(command!) && (values.has('--cutover-plan')||values.has('--cutover-plan-sha256'))) throw new Error('embedding.cutover_arguments');
  if(command==='rollback'&&(!values.get('--reason')||!values.get('--rollback-evidence-sha256')))throw new Error('embedding.rollback_evidence');
  if(command!=='rollback'&&(values.has('--reason')||values.has('--rollback-evidence-sha256')))throw new Error('embedding.rollback_arguments');
  return { command: command as 'inspect'|'build'|'attest-cutover'|'activate'|'rollback'|'complete', database, apply, runId: values.get('--run-id'),
    manifestPath: values.get('--manifest'), manifestSha256: values.get('--manifest-sha256'),
    attestationPath: values.get('--attestation'), cutoverWatermark: values.get('--cutover-watermark'),
    cutoverPlanPath:values.get('--cutover-plan'),cutoverPlanSha256:values.get('--cutover-plan-sha256'),reason:values.get('--reason'),rollbackEvidenceSha256:values.get('--rollback-evidence-sha256') };
}

async function main() {
  const args=parseShadowIndexArguments(process.argv.slice(2));
  const connectionString=process.env.SHADOW_EMBEDDING_DATABASE_URL;
  if (!connectionString?.trim()) throw new Error('embedding.operator_url_required');
  const pool=new pg.Pool({connectionString,max:1,connectionTimeoutMillis:5000,application_name:'total-recall-shadow-index'});
  try {
    const client=await pool.connect();
    try {
      if (args.command==='inspect') console.log(JSON.stringify(await inspectShadowIndex(client,args.database),null,2));
      else {
        const manifest=JSON.parse(await readFile(args.manifestPath!,'utf8'));
        const envelope=validateOperationalManifest(manifest,args.manifestSha256!);
        if (args.command==='build') {
          const plan=(envelope.manifest.resources as typeof envelope.manifest.resources & {indexBuild?:unknown}).indexBuild;
          console.log(JSON.stringify(await buildShadowIndex(client,args.database,args.runId!,envelope,plan),null,2));
        } else if(args.command==='complete') {
          const attestation=JSON.parse(await readFile(args.attestationPath!,'utf8'));
          console.log(JSON.stringify(await completeShadowRun(client,args.database,args.runId!,envelope,attestation,args.cutoverWatermark!),null,2));
        } else {
          const plan=JSON.parse(await readFile(args.cutoverPlanPath!,'utf8'));
          const cutover=validateCutoverPlan(plan,args.cutoverPlanSha256!,envelope);
          if(cutover.plan.runId!==args.runId)throw new Error('embedding.cutover_run_binding');
          console.log(JSON.stringify(args.command==='attest-cutover'?await attestCutover(client,args.database,envelope,cutover)
            :args.command==='activate'?await activateCutover(client,args.database,envelope,cutover)
            :await rollbackCutover(client,args.database,envelope,cutover,args.reason!,args.rollbackEvidenceSha256!),null,2));
        }
      }
    } finally { client.release(); }
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{
  console.error(error instanceof Error && /^embedding\./u.test(error.message)?error.message:'shadow_embedding_index_failed'); process.exitCode=1;
});
