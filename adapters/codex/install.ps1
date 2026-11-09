<#
.SYNOPSIS
  Install the HALOFLUX Codex CLI adapter.
.DESCRIPTION
  Deep-merges HALOFLUX hook entries into %USERPROFILE%\.codex\hooks.json,
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
$arguments = @($installer, 'codex', '--action', 'install', '--node', $NodePath)
if ($ConfigRoot) { $arguments += @('--config-root', $ConfigRoot) }
if ($BackupRoot) { $arguments += @('--backup-root', $BackupRoot) }
if ($BridgeUrl)  { $arguments += @('--bridge-url', $BridgeUrl) }
if ($HostVersion){ $arguments += @('--host-version', $HostVersion) }
if ($DryRun)     { $arguments += '--dry-run' }
if ($Json)       { $arguments += '--json' }
& $NodePath @arguments
exit $LASTEXITCODE