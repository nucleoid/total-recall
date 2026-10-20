param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z0-9_.-]+$')]
  [string]$SshHost,
  [switch]$IncludeAccessLevel
)

# Windows operator helper. No production connection string is read or copied.
# The selected SSH host must already be authorized for these bounded tests.
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRunId = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$testName = "total-recall-shadow-test-$testRunId"
$remoteScratch = "/tmp/total-recall-shadow-test-$testRunId"
$localScratch = Join-Path $repoRoot ".reembedding/integration/$testRunId"
$compiledRelative = ".reembedding/integration/$testRunId/compiled"
$compiledPath = Join-Path $repoRoot $compiledRelative
$bundlePath = Join-Path $localScratch 'verification.tar'
$sshFlags = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ClearAllForwardings=yes')
$databaseStarted = $false

function Invoke-TestRemote([string]$Command) {
  & ssh @sshFlags $SshHost $Command
  if ($LASTEXITCODE -ne 0) { throw 'Isolated test SSH command failed' }
}

New-Item -ItemType Directory -Path $localScratch -Force | Out-Null
Push-Location $repoRoot
try {
  $integrationSources = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'test') -Filter 'shadow-embedding-*.integration.test.ts' | Sort-Object Name | ForEach-Object { 'test/' + $_.Name })
  $extraSources=@()
  if($IncludeAccessLevel){$extraSources=@('test/access-level.db.ts')}
  & node node_modules/typescript/bin/tsc @integrationSources @extraSources src/search.ts src/tools/store.ts --outDir $compiledPath --module Node16 --target ES2022 --strict --esModuleInterop --skipLibCheck
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic test compilation failed' }
  $dependencies = @('dotenv', 'zod', 'pg', 'pg-pool', 'pg-protocol', 'pg-connection-string', 'pg-types', 'pgpass', 'pg-int8',
    'postgres-array', 'postgres-bytea', 'postgres-date', 'postgres-interval', 'xtend', 'split2', 'pg-cloudflare')
  $bundleEntries = @($compiledRelative, 'package.json') + @($dependencies | ForEach-Object { "node_modules/$_" })
  if($IncludeAccessLevel){$bundleEntries+=@('test/setup-embedding-env.mjs')}
  & tar -cf $bundlePath @bundleEntries
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic verification bundle failed' }
  # mkdir fails on collision; never reuse somebody else's scratch or container.
  Invoke-TestRemote "mkdir -m 700 $remoteScratch"
  & scp @sshFlags $bundlePath "${SshHost}:$remoteScratch/verification.tar"
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic verification transfer failed' }
  Invoke-TestRemote "docker run --detach --name $testName --label total-recall.shadow-test=$testRunId --network none --memory 384m --cpus 1 --pids-limit 128 --shm-size 64m --tmpfs /var/lib/postgresql/data:rw,size=256m -e POSTGRES_HOST_AUTH_METHOD=trust pgvector/pgvector:pg16"
  $databaseStarted = $true
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & ssh @sshFlags $SshHost "docker exec $testName pg_isready -U postgres" 2>$null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (!$ready) { throw 'Disposable PostgreSQL readiness timed out' }
  # Prove that the exact archive/restore form used by the rehearsal recreates
  # the database when pg_restore connects through the maintenance database.
  $archiveDatabase = "backup_create_$testRunId"
  "CREATE DATABASE $archiveDatabase;" | & ssh @sshFlags $SshHost "docker exec -i $testName psql -X -q -U postgres -d postgres -v ON_ERROR_STOP=1"
  if ($LASTEXITCODE -ne 0) { throw 'Archive round-trip database creation failed' }
  "CREATE TABLE public.restore_probe(value text NOT NULL); INSERT INTO public.restore_probe VALUES ('archive-create-ok');" |
    & ssh @sshFlags $SshHost "docker exec -i $testName psql -X -q -U postgres -d $archiveDatabase -v ON_ERROR_STOP=1"
  if ($LASTEXITCODE -ne 0) { throw 'Archive round-trip fixture creation failed' }
  Invoke-TestRemote "docker exec $testName pg_dump -Fc --create --no-password -U postgres -d $archiveDatabase -f /tmp/backup-create-test.custom"
  "DROP DATABASE $archiveDatabase;" | & ssh @sshFlags $SshHost "docker exec -i $testName psql -X -q -U postgres -d postgres -v ON_ERROR_STOP=1"
  if ($LASTEXITCODE -ne 0) { throw 'Archive round-trip database drop failed' }
  Invoke-TestRemote "docker exec $testName pg_restore --create --exit-on-error --no-password -U postgres --dbname postgres /tmp/backup-create-test.custom"
  $archiveProbe = & ssh @sshFlags $SshHost "docker exec $testName psql -XAtq -U postgres -d $archiveDatabase -v ON_ERROR_STOP=1 -c 'SELECT value FROM public.restore_probe'"
  if ($LASTEXITCODE -ne 0 -or "$archiveProbe".Trim() -ne 'archive-create-ok') { throw 'Archive round-trip verification failed' }
  "DROP DATABASE $archiveDatabase;" | & ssh @sshFlags $SshHost "docker exec -i $testName psql -X -q -U postgres -d postgres -v ON_ERROR_STOP=1"
  if ($LASTEXITCODE -ne 0) { throw 'Archive round-trip cleanup failed' }
  'CREATE DATABASE total_recall_reembedding_test;' | & ssh @sshFlags $SshHost "docker exec -i $testName psql -X -q -U postgres -v ON_ERROR_STOP=1"
  if ($LASTEXITCODE -ne 0) { throw 'Disposable database creation failed' }
  $schemaSql = @'
SET client_min_messages='warning';
DO $$ BEGIN IF current_database()<>'total_recall_reembedding_test' THEN RAISE EXCEPTION 'wrong test database'; END IF; END $$;
CREATE EXTENSION vector; CREATE EXTENSION pgcrypto; CREATE ROLE total_recall_app LOGIN;
'@
  foreach ($migration in (Get-ChildItem (Join-Path $repoRoot 'migrations/*.sql') | Sort-Object Name)) {
    $schemaSql += "`nBEGIN;`n" + [IO.File]::ReadAllText($migration.FullName) + "`nCOMMIT;`n"
  }
  $schemaSql += [IO.File]::ReadAllText((Join-Path $repoRoot 'test/shadow-embedding-schema.sql'))
  $schemaSql | & ssh @sshFlags $SshHost "docker exec -i $testName psql -X -q -U postgres -d total_recall_reembedding_test -v ON_ERROR_STOP=1"
  if ($LASTEXITCODE -ne 0) { throw 'Disposable schema/SQL assertions failed' }
  Invoke-TestRemote "tar -xf $remoteScratch/verification.tar -C $remoteScratch"
  $integrationJs = ($integrationSources | ForEach-Object { "$compiledRelative/" + ($_ -replace '\.ts$', '.js') }) -join ' '
  Invoke-TestRemote "docker run --rm --name $testName-node --label total-recall.shadow-test=$testRunId --network container:$testName --memory 384m --cpus 1 --pids-limit 128 --mount type=bind,src=$remoteScratch,dst=/work,readonly --workdir /work -e SHADOW_EMBEDDING_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1/total_recall_reembedding_test node:20-bookworm-slim timeout 90s node --test --test-concurrency=1 $integrationJs"
  if($IncludeAccessLevel){
    $accessDatabase="total_recall_access_test_$testRunId"
    "CREATE DATABASE $accessDatabase;" | & ssh @sshFlags $SshHost "docker exec -i $testName psql -X -q -U postgres -v ON_ERROR_STOP=1"
    if($LASTEXITCODE -ne 0){throw 'Disposable access-level database creation failed'}
    Invoke-TestRemote "docker run --rm --name $testName-node --label total-recall.shadow-test=$testRunId --network container:$testName --memory 384m --cpus 1 --pids-limit 128 --mount type=bind,src=$remoteScratch,dst=/work,readonly --workdir /work -e DATABASE_URL=postgresql://postgres@127.0.0.1/$accessDatabase node:20-bookworm-slim timeout 60s node --import ./test/setup-embedding-env.mjs $compiledRelative/test/access-level.db.js"
  }
  [IO.File]::WriteAllText((Join-Path $localScratch 'receipt.json'), (@{
    kind = 'synthetic-isolated-postgresql'; run_id = $testRunId; status = 'passed';
    database = 'total_recall_reembedding_test'; network = 'none';
    completed_at = [DateTime]::UtcNow.ToString('o')
    legacy_access_level_matrix = [bool]$IncludeAccessLevel
  } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
} finally {
  if ($databaseStarted) {
    # Remove only exact names that carry this invocation's generated owner label.
    foreach ($ownedName in @("$testName-node", $testName)) {
      $ownedId = & ssh @sshFlags $SshHost "docker ps -aq --filter name=^/${ownedName}$ --filter label=total-recall.shadow-test=$testRunId"
      if ($LASTEXITCODE -eq 0 -and "$ownedId".Trim()) {
        & ssh @sshFlags $SshHost "docker rm -f $ownedName"
        if ($LASTEXITCODE -ne 0) { Write-Warning "Owned test container cleanup failed: $ownedName" }
      }
    }
  }
  Pop-Location
}
