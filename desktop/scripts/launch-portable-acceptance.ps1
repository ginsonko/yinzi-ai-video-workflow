param(
  [string]$ProfileName = 'portable-v012-beta1',
  [ValidateRange(0, 65535)]
  [int]$RemoteDebuggingPort = 9226
)

$ErrorActionPreference = 'Stop'
$desktopDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$profileRoot = [IO.Path]::GetFullPath((Join-Path $desktopDir (Join-Path 'release-acceptance' $ProfileName)))
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $desktopDir 'release-acceptance'))
if (-not $profileRoot.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Acceptance profile is outside the allowed directory: $profileRoot"
}

$appData = Join-Path $profileRoot 'AppData\Roaming'
$localAppData = Join-Path $profileRoot 'AppData\Local'
$releaseDir = Join-Path $desktopDir 'release'
$portableItem = Get-ChildItem -LiteralPath $releaseDir -Filter '*Portable-0.1.2-beta.1-x64.exe' -File | Select-Object -First 1
if (-not $portableItem) { throw "Portable release not found in: $releaseDir" }
$portable = $portableItem.FullName
New-Item -ItemType Directory -Path $appData -Force | Out-Null
New-Item -ItemType Directory -Path $localAppData -Force | Out-Null
$env:APPDATA = $appData
$env:LOCALAPPDATA = $localAppData
$env:YINZI_ACCEPTANCE_APPDATA = $appData
$env:Path = 'C:\Windows\System32;C:\Windows'

$process = Start-Process -FilePath $portable -ArgumentList "--remote-debugging-port=$RemoteDebuggingPort" -PassThru -WindowStyle Hidden
Write-Output "ACCEPTANCE_PROFILE=$profileRoot"
Write-Output "ACCEPTANCE_APPDATA=$appData"
Write-Output "ACCEPTANCE_EXE=$portable"
Write-Output "ACCEPTANCE_PID=$($process.Id)"
