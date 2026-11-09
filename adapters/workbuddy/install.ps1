<#
.SYNOPSIS
  Install the HALOFLUX WorkBuddy adapter.
.DESCRIPTION
  Mode Mcp (default): registers `mcpServers["haloflux-status"]` in
  %USERPROFILE%\.workbuddy\mcp.json - a local stdio MCP server exposing
  `haloflux_status` (read-only) and `haloflux_report` (coarse state reporting).
  The original mcp.json is backed up to config/backups/<utc-ts>/ and a manifest
  is written; uninstall removes only that one server entry and restores the
  byte-identical original.

  Mode Watcher: does NOT touch any WorkBuddy config. It only prints the command
  that tails ~/.workbuddy/traces and derives events (source=derived,
  confidence=inferred).
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
.EXAMPLE
  .\install.ps1 -Mode Watcher
.EXAMPLE
  .\install.ps1 -ConfigRoot D:\tmp\wb -BackupRoot D:\tmp\backups -DryRun -Json
#>
[CmdletBinding()]
param(
  [string]$ConfigRoot,
  [string]$BackupRoot,
  [string]$BridgeUrl,
  [string]$NodePath,
  [string]$HostVersion,
  [ValidateSet('Mcp','Watcher')][string]$Mode = 'Mcp',
  [switch]$DryRun,
  [switch]$Json
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$adapter = Join-Path $here 'adapter.mjs'
$installer = Join-Path $here '..\_shared\installer.mjs'
if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { Write-Error 'node.exe not found on PATH; pass -NodePath.'; exit 1 }
  $NodePath = $cmd.Source
}
if ($Mode -eq 'Watcher') {
  Write-Host 'WorkBuddy: watcher mode selected - no host config was modified.' -ForegroundColor Yellow
  Write-Host "  Run: & '$NodePath' '$adapter' --watch"
  Write-Host '  Derives session/tool events from ~/.workbuddy/traces (source=derived, confidence=inferred).'
  exit 0
}
$arguments = @($installer, 'workbuddy', '--action', 'install', '--node', $NodePath)
if ($ConfigRoot) { $arguments += @('--config-root', $ConfigRoot) }
if ($BackupRoot) { $arguments += @('--backup-root', $BackupRoot) }
if ($BridgeUrl)  { $arguments += @('--bridge-url', $BridgeUrl) }
if ($HostVersion){ $arguments += @('--host-version', $HostVersion) }
if ($DryRun)     { $arguments += '--dry-run' }
if ($Json)       { $arguments += '--json' }
& $NodePath @arguments
exit $LASTEXITCODE
