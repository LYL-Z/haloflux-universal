<#
.SYNOPSIS
  Install the HALOFLUX TRAE CN adapter.
.DESCRIPTION
  Deep-merges HALOFLUX hook entries into %USERPROFILE%\.trae-cn\hooks.json,
  backing the original up to config/backups/<utc-ts>/ and writing a manifest.json.
  Existing entries (e.g. AgentHaven-managed hooks) are preserved byte-for-byte on
  uninstall. Idempotent: re-running keeps the ORIGINAL backup.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
.EXAMPLE
  .\install.ps1 -ConfigRoot D:\tmp\claude -BackupRoot D:\tmp\backups -DryRun -Json
#>
[CmdletBinding()]
param(
  [string]$ConfigRoot,
  [string]$BackupRoot,
  [string]$BridgeUrl,
  [string]$NodePath,
  [string]$HostVersion,
  [ValidateSet('Watcher','Hooks')][string]$Mode = 'Watcher',
  [switch]$DryRun,
  [switch]$Json
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $here '..\_shared\installer.mjs'
if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { Write-Error 'node.exe not found on PATH; pass -NodePath.'; exit 1 }
  $NodePath = $cmd.Source
}
$arguments = @($installer, 'trae', '--action', 'install', '--node', $NodePath)
if ($ConfigRoot) { $arguments += @('--config-root', $ConfigRoot) }
if ($BackupRoot) { $arguments += @('--backup-root', $BackupRoot) }
if ($BridgeUrl)  { $arguments += @('--bridge-url', $BridgeUrl) }
if ($HostVersion){ $arguments += @('--host-version', $HostVersion) }
if ($Mode -ne 'Hooks') {
  Write-Host 'TRAE: hook file format is UNVERIFIED on 3.4.13; nothing was written to ~/.trae-cn.' -ForegroundColor Yellow
  Write-Host '  Re-run with -Mode Hooks to force the Cursor-compatible hooks.json (backed up, reversible).'
  exit 0
}
$arguments += @('--mode', 'Hooks')
if ($DryRun)     { $arguments += '--dry-run' }
if ($Json)       { $arguments += '--json' }
& $NodePath @arguments
exit $LASTEXITCODE