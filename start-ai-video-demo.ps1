[CmdletBinding()]
param(
  [int]$BackendPort = 5683,
  [int]$FrontendPort = 3015,
  [string]$RuntimeRoot = '',
  [string]$RunId = 'c58a7390-be92-44d0-899d-42239131b952',
  [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$workRoot = Split-Path -Parent $projectRoot
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  $RuntimeRoot = Join-Path $workRoot 'runtime-adaptive-ui-20260807'
}
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)

$backendScript = Join-Path $projectRoot 'backend-node\src\server.js'
$frontendRoot = Join-Path $projectRoot 'frontweb'
$runtimeConfig = Join-Path $RuntimeRoot 'config.yaml'
$runtimeDatabase = Join-Path $RuntimeRoot 'data\acceptance.db'
$logRoot = Join-Path $RuntimeRoot 'logs'
$backendBaseUrl = "http://127.0.0.1:$BackendPort"
$frontendBaseUrl = "http://127.0.0.1:$FrontendPort"
$runApiPath = "/api/v1/production-runs/$RunId"
$workflowUrl = "$frontendBaseUrl/workflow/1?run=$RunId"

function Assert-File([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label not found: $Path"
  }
}

function Get-ListenerProcessId([int]$Port) {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $listener) {
    return $null
  }
  return [int]$listener.OwningProcess
}

function Test-HttpSuccess([string]$Url, [int]$TimeoutSec = 2) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -Method Get -TimeoutSec $TimeoutSec
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Wait-HttpSuccess([string]$Url, [int]$TimeoutSec = 20) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ($timer.Elapsed.TotalSeconds -lt $TimeoutSec) {
    if (Test-HttpSuccess -Url $Url -TimeoutSec 2) {
      return $true
    }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Stop-StartedProcess($Process) {
  if ($null -eq $Process) {
    return
  }
  try {
    if (-not $Process.HasExited) {
      Stop-Process -Id $Process.Id -Force -ErrorAction Stop
    }
  } catch {
    Write-Warning "Could not stop failed process $($Process.Id): $($_.Exception.Message)"
  }
}

Assert-File -Path $backendScript -Label 'Backend entry point'
Assert-File -Path $runtimeConfig -Label 'Runtime config'
Assert-File -Path $runtimeDatabase -Label 'Acceptance database'
if (-not (Test-Path -LiteralPath $frontendRoot -PathType Container)) {
  throw "Frontend directory not found: $frontendRoot"
}
if (-not (Select-String -LiteralPath $runtimeConfig -SimpleMatch 'path: ./data/acceptance.db' -Quiet)) {
  throw "Runtime config does not point to ./data/acceptance.db: $runtimeConfig"
}

$node = Get-Command node.exe -ErrorAction Stop
$npm = Get-Command npm.cmd -ErrorAction Stop
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backendStdout = Join-Path $logRoot "backend-$stamp.stdout.log"
$backendStderr = Join-Path $logRoot "backend-$stamp.stderr.log"
$frontendStdout = Join-Path $logRoot "frontend-$stamp.stdout.log"
$frontendStderr = Join-Path $logRoot "frontend-$stamp.stderr.log"

$startedBackend = $null
$startedFrontend = $null

try {
  $backendOwner = Get-ListenerProcessId -Port $BackendPort
  if ($null -ne $backendOwner) {
    if (-not (Test-HttpSuccess -Url "$backendBaseUrl/health")) {
      throw "Port $BackendPort is occupied by PID $backendOwner, but it is not the expected healthy backend."
    }
    Write-Host "Backend already healthy on $backendBaseUrl (PID $backendOwner)." -ForegroundColor Green
  } else {
    Write-Host "Starting backend on $backendBaseUrl..." -ForegroundColor Cyan
    $previousPort = $env:PORT
    try {
      $env:PORT = [string]$BackendPort
      $startedBackend = Start-Process `
        -FilePath $node.Source `
        -ArgumentList @($backendScript) `
        -WorkingDirectory $RuntimeRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $backendStdout `
        -RedirectStandardError $backendStderr `
        -PassThru
    } finally {
      $env:PORT = $previousPort
    }
    if (-not (Wait-HttpSuccess -Url "$backendBaseUrl/health" -TimeoutSec 20)) {
      throw "Backend did not become healthy. Logs: $backendStdout ; $backendStderr"
    }
    Write-Host "Backend ready (PID $($startedBackend.Id))." -ForegroundColor Green
  }

  $backendRun = Invoke-RestMethod -Uri "$backendBaseUrl$runApiPath" -Method Get -TimeoutSec 5
  if (-not $backendRun.success -or $backendRun.data.run.id -ne $RunId) {
    throw "Backend is healthy but does not serve expected run $RunId. Check runtime database: $runtimeDatabase"
  }

  $frontendOwner = Get-ListenerProcessId -Port $FrontendPort
  if ($null -ne $frontendOwner) {
    if (-not (Test-HttpSuccess -Url $frontendBaseUrl)) {
      throw "Port $FrontendPort is occupied by PID $frontendOwner, but it is not a healthy frontend."
    }
    Write-Host "Frontend already healthy on $frontendBaseUrl (PID $frontendOwner)." -ForegroundColor Green
  } else {
    Write-Host "Starting frontend on $frontendBaseUrl..." -ForegroundColor Cyan
    $previousTarget = $env:LOCAL_MINIDRAMA_API_TARGET
    try {
      $env:LOCAL_MINIDRAMA_API_TARGET = $backendBaseUrl
      $startedFrontend = Start-Process `
        -FilePath $npm.Source `
        -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1', '--port', [string]$FrontendPort) `
        -WorkingDirectory $frontendRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $frontendStdout `
        -RedirectStandardError $frontendStderr `
        -PassThru
    } finally {
      $env:LOCAL_MINIDRAMA_API_TARGET = $previousTarget
    }
    if (-not (Wait-HttpSuccess -Url $frontendBaseUrl -TimeoutSec 20)) {
      throw "Frontend did not become healthy. Logs: $frontendStdout ; $frontendStderr"
    }
    Write-Host "Frontend ready (PID $($startedFrontend.Id))." -ForegroundColor Green
  }

  $proxiedRun = Invoke-RestMethod -Uri "$frontendBaseUrl$runApiPath" -Method Get -TimeoutSec 5
  if (-not $proxiedRun.success -or $proxiedRun.data.run.id -ne $RunId) {
    throw "Frontend proxy does not serve expected run $RunId."
  }

  $run = $proxiedRun.data.run
  Write-Host ''
  Write-Host 'AI video demo is ready.' -ForegroundColor Green
  Write-Host "  Page:    $workflowUrl"
  Write-Host "  State:   $($run.status) / $($run.current_stage) / shot $($run.current_scope_id)"
  Write-Host "  Usage:   $($run.usage.video_attempts_reserved) attempts / $($run.usage.video_seconds_reserved) seconds"
  if ($null -ne $startedBackend) {
    Write-Host "  Backend logs: $backendStdout ; $backendStderr"
  }
  if ($null -ne $startedFrontend) {
    Write-Host "  Frontend logs: $frontendStdout ; $frontendStderr"
  }
} catch {
  Stop-StartedProcess -Process $startedFrontend
  Stop-StartedProcess -Process $startedBackend
  throw
}

if (-not $NoBrowser) {
  try {
    Start-Process -FilePath $workflowUrl | Out-Null
  } catch {
    Write-Warning "Services are ready, but the browser could not be opened automatically: $($_.Exception.Message)"
  }
}
