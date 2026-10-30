param([Parameter(Mandatory=$true)][string]$RuntimeDirectory,
  [Parameter(Mandatory=$true)][string]$ModelPath,
  [switch]$ExportSyntheticReference,
  [switch]$DisableVulkanFp16,
  [switch]$DisableVulkanQuantizedMatVec,
  [switch]$DisableVulkanIntegerDot)
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$scratch=Join-Path $repoRoot ('.reembedding/runtime/'+[Guid]::NewGuid().ToString('N'))
$model=(Resolve-Path -LiteralPath $ModelPath).Path
$executable=(Resolve-Path -LiteralPath (Join-Path $RuntimeDirectory 'llama-server.exe')).Path
if ((Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'b60ae5ce2dd6a0b77f82cadf21def1f310a3e10cde380ad0081b07a9d416949d') { throw 'Model identity mismatch' }
$version=(& $executable --version 2>&1 | Out-String)
if ($version -notmatch 'build 11669, commit 620d2225c') { throw 'Runtime build mismatch' }
$runtimeFiles=@(Get-ChildItem -LiteralPath $RuntimeDirectory -File -Recurse | Sort-Object FullName | ForEach-Object {
  if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime contains a reparse point' }
  @{path=[IO.Path]::GetRelativePath($RuntimeDirectory,$_.FullName).Replace('\','/');bytes=$_.Length;
    sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$runtimeFilesJson=$runtimeFiles | ConvertTo-Json -Depth 5 -Compress
$runtimeFilesSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($runtimeFilesJson))).ToLowerInvariant()
$temperatures=@(& nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits)
if ($LASTEXITCODE -ne 0 -or !$temperatures.Count) { throw 'Thermal readings unavailable' }
foreach ($reading in $temperatures) { if ($reading -notmatch '^\d+$' -or [int]$reading -ge 85) { throw 'Thermal guard' } }
New-Item -ItemType Directory -Path $scratch | Out-Null
$keyBytes=New-Object byte[] 32
$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
try {$rng.GetBytes($keyBytes)} finally {$rng.Dispose()}
$key=[Convert]::ToBase64String($keyBytes)
$keyFile=Join-Path $scratch 'owned-key.txt'
[IO.File]::WriteAllText($keyFile,$key)
$owned=@()
try {
  foreach ($profile in @(@{port=18091;gpu=99;name='gpu'},@{port=18092;gpu=0;name='cpu'})) {
    # Bind probe fails on any existing listener; never stop a pre-existing process.
    $probe=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$profile.port)
    $probe.Start(); $probe.Stop()
    $arguments=@('-m',('"'+$model+'"'),'--embedding','--pooling','last','-c','4096','-b','2048','-ub','2048',
      '-np','1','-t','2','-ngl',[string]$profile.gpu,'--host','127.0.0.1','--port',[string]$profile.port,
      '--api-key-file',('"'+$keyFile+'"'))
    $launchOptions=@{FilePath=$executable;ArgumentList=$arguments;WindowStyle='Hidden';PassThru=$true;
      RedirectStandardOutput=(Join-Path $scratch ($profile.name+'.out.log'));RedirectStandardError=(Join-Path $scratch ($profile.name+'.err.log'))}
    $previousPrecision=$env:GGML_VK_DISABLE_F16
    $previousMatVec=$env:GGML_VK_DISABLE_MMVQ
    $previousIntegerDot=$env:GGML_VK_DISABLE_INTEGER_DOT_PRODUCT
    try {
      if ($DisableVulkanFp16) {$env:GGML_VK_DISABLE_F16='1'}
      if ($DisableVulkanQuantizedMatVec) {$env:GGML_VK_DISABLE_MMVQ='1'}
      if ($DisableVulkanIntegerDot) {$env:GGML_VK_DISABLE_INTEGER_DOT_PRODUCT='1'}
      $process=Start-Process @launchOptions
    } finally {$env:GGML_VK_DISABLE_F16=$previousPrecision;$env:GGML_VK_DISABLE_MMVQ=$previousMatVec;$env:GGML_VK_DISABLE_INTEGER_DOT_PRODUCT=$previousIntegerDot}
    $owned+=@{process=$process;port=$profile.port;name=$profile.name}
  }
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  foreach ($item in $owned) {
    $ready=$false
    while ([DateTime]::UtcNow -lt $deadline) {
      if ($item.process.HasExited) { throw 'Owned runtime exited before readiness' }
      try {
        $health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$item.port+'/health') -Headers @{Authorization=('Bearer '+$key)} -TimeoutSec 2
        if ($health.status -eq 'ok') {$ready=$true;break}
      } catch {}
      Start-Sleep -Milliseconds 500
    }
    if (!$ready) {throw 'Owned runtime readiness timeout'}
  }
  Push-Location $repoRoot
  try {
    $identity=@{schema=1;contractId='91e3bb787cf8c10c8dcd2e1a724d3b18acfc03a1ea063ee920548e99e7b95d97';runtimeContract='llama.cpp/b11669/last-pool/tokenize-special/native2560';disableVulkanFp16=[bool]$DisableVulkanFp16;disableVulkanQuantizedMatVec=[bool]$DisableVulkanQuantizedMatVec;disableVulkanIntegerDot=[bool]$DisableVulkanIntegerDot;
      artifactSha256=(Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash.ToLowerInvariant();
      binarySha256=(Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant();
      runtimeFilesSha256=$runtimeFilesSha256;runtimeFiles=$runtimeFiles;runtimeVersion=$version.Trim();
      processes=@($owned | ForEach-Object { @{name=$_.name;pid=$_.process.Id;workingSetBytes=$_.process.WorkingSet64} })}
    $identity | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $scratch 'launch-identity.json')
    $referenceArguments=@()
    if ($ExportSyntheticReference) {$referenceArguments=@((Join-Path $scratch 'synthetic-reference.json'))}
    & node --import tsx scripts/check-local-embedding-runtime.ts http://127.0.0.1:18091 http://127.0.0.1:18092 $keyFile (Join-Path $scratch 'acceptance.json') @referenceArguments
    if ($LASTEXITCODE -ne 0) {throw 'Synthetic runtime acceptance failed'}
    @{schema=1;processes=@($owned | ForEach-Object { $_.process.Refresh(); @{name=$_.name;pid=$_.process.Id;hasExited=$_.process.HasExited;workingSetBytes=$_.process.WorkingSet64;peakWorkingSetBytes=$_.process.PeakWorkingSet64} });
      launchIdentitySha256=(Get-FileHash -LiteralPath (Join-Path $scratch 'launch-identity.json') -Algorithm SHA256).Hash.ToLowerInvariant()} |
      ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $scratch 'process.json')
  } finally {Pop-Location}
} finally {
  foreach ($item in $owned) { if (!$item.process.HasExited) { $item.process.Kill(); $item.process.WaitForExit(5000) | Out-Null } }
  Remove-Item -LiteralPath $keyFile -Force -ErrorAction SilentlyContinue
  $cleanup=@{ownedProcessesExited=@($owned | ForEach-Object {$_.process.HasExited});keyRemoved=!(Test-Path -LiteralPath $keyFile)}
  $cleanup | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $scratch 'cleanup.json')
  $artifactHashes=@{}
  foreach($name in @('launch-identity.json','acceptance.json','process.json','cleanup.json')) {
    $path=Join-Path $scratch $name
    if (Test-Path -LiteralPath $path) {$artifactHashes[$name]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
  }
  $complete=@('launch-identity.json','acceptance.json','process.json','cleanup.json') | Where-Object {-not $artifactHashes.ContainsKey($_)}
  $finalStatus=if($cleanup.keyRemoved -and @($cleanup.ownedProcessesExited | Where-Object {-not $_}).Count -eq 0 -and $complete.Count -eq 0){'pass'}else{'fail'}
  @{schema=1;status=$finalStatus;
    artifacts=$artifactHashes;createdAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath (Join-Path $scratch 'final-manifest.json')
  Write-Output ('Runtime receipts: '+$scratch)
}
