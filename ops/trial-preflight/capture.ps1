$ErrorActionPreference='Stop'
$outDir=Join-Path $PSScriptRoot 'evidence'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$owners=@(Get-NetTCPConnection -LocalPort 8377 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
$processes=@()
foreach($ownerId in $owners){
  $listener=Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
  foreach($proc in @($listener,(Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.ParentProcessId)"))){
    $flags=@()
    foreach($flag in @('--profile','--profile-dir','--config','--home','--patch')){
      $found=[regex]::Match($proc.CommandLine,([regex]::Escape($flag)+'(?:=|\s+)(?:"([^"]+)"|([^\s"]+))'))
      if($found.Success){$value=$found.Groups[1].Value;if(-not $value){$value=$found.Groups[2].Value};$safe=$value;if($value -match '://.*@'){$safe='[redacted-url]'};$flags+=([pscustomobject]@{Flag=$flag;Value=$safe})}
    }
    $processes+=([pscustomobject]@{Pid=$proc.ProcessId;ParentPid=$proc.ParentProcessId;ExecutablePath=$proc.ExecutablePath;CreationTimeUtc=$proc.CreationDate.ToUniversalTime().ToString('o');RecognizedFlags=$flags})
  }
}
$links=@()
foreach($name in @('dsh-mind','dsh-mind-kernel','dsh-mind-guard','dsh-mind-board')){
  $candidate=Join-Path (Join-Path $env:DSH_PROFILE_DIR 'node_modules') $name
  $item=Get-Item -LiteralPath $candidate -Force
  $links+=([pscustomobject]@{Name=$name;Path=$item.FullName;LinkType=$item.LinkType;Target=@($item.Target)})
}
$hashes=@()
foreach($name in @('package.json','cordis.yml','cordis.patch.yml')){
  $file=Join-Path $env:DSH_PROFILE_DIR $name
  $hash=Get-FileHash -LiteralPath $file -Algorithm SHA256
  $info=Get-Item -LiteralPath $file
  $hashes+=([pscustomobject]@{Path=$file;SHA256=$hash.Hash.ToLowerInvariant();Bytes=$info.Length;LastWriteTimeUtc=$info.LastWriteTimeUtc.ToString('o')})
}
$result=[pscustomobject]@{AtUtc=[DateTime]::UtcNow.ToString('o');ManagedEnvironment=[pscustomobject]@{Profile=$env:DSH_PROFILE;ProfileDirectory=$env:DSH_PROFILE_DIR;Home=$env:DSH_HOME;WebUrl=$env:DSH_WEB_URL};ListenerPids=$owners;Processes=$processes;PackageLinks=$links;ProfileFileHashes=$hashes;RawCommandLineSaved=$false;CredentialsSaved=$false;AppliedAnyChange=$false}
$result | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $outDir 'host.json') -Encoding UTF8
$result | ConvertTo-Json -Depth 7
