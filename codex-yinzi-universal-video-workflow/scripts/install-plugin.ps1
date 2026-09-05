[CmdletBinding()]
param(
  [string]$Repository = 'https://github.com/ginsonko/yinzi-ai-video-workflow.git',
  [string]$InstallRoot = '',
  [switch]$SkipMarketplaceInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
  $InstallRoot = Join-Path $localAppData 'Yinzi\CodexVideoWorkflow\source'
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$parent = Split-Path -Parent $InstallRoot
New-Item -ItemType Directory -Path $parent -Force | Out-Null

$git = Get-Command git.exe -ErrorAction Stop
if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot '.git') -PathType Container)) {
  if (Test-Path -LiteralPath $InstallRoot) {
    $entries = @(Get-ChildItem -LiteralPath $InstallRoot -Force)
    if ($entries.Count -gt 0) { throw "安装目录已存在且不是 Git 工作树：$InstallRoot" }
  }
  & $git.Source clone --depth 1 --filter=blob:none $Repository $InstallRoot
  if ($LASTEXITCODE -ne 0) { throw "GitHub 项目拉取失败（退出码 $LASTEXITCODE）" }
} else {
  $dirty = (& $git.Source -C $InstallRoot status --porcelain)
  if ($dirty) { throw "安装目录有未提交修改，已停止更新以保护本地内容：$InstallRoot" }
  & $git.Source -C $InstallRoot pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw "GitHub 项目更新失败；请先处理分支或网络状态" }
}

$marketplaceRoot = Join-Path $InstallRoot 'codex-yinzi-universal-video-workflow'
$manifest = Join-Path $marketplaceRoot '.agents\plugins\marketplace.json'
$pluginPath = Join-Path $marketplaceRoot 'plugins\codex-yinzi-universal-video-workflow'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $pluginPath '.codex-plugin\plugin.json') -PathType Leaf)) {
  throw "GitHub 项目缺少合法插件清单：$marketplaceRoot"
}

if (-not $SkipMarketplaceInstall) {
  $codex = Get-Command codex.exe -ErrorAction Stop
  & $codex.Source plugin marketplace add $marketplaceRoot
  if ($LASTEXITCODE -ne 0) { throw "Codex Marketplace 注册失败（退出码 $LASTEXITCODE）" }
  & $codex.Source plugin add 'codex-yinzi-universal-video-workflow@yinzi-video-workflow'
  if ($LASTEXITCODE -ne 0) { throw "Codex 插件安装失败（退出码 $LASTEXITCODE）" }
}

[pscustomobject]@{
  ok = $true
  source_root = $InstallRoot
  marketplace = $manifest
  plugin = 'codex-yinzi-universal-video-workflow'
  next_step = '请在新 Codex 任务中描述目标；技能会先给通俗计划并等待实际付费/外部动作许可。'
} | ConvertTo-Json -Depth 4
