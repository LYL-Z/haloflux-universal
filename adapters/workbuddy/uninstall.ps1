<#
.SYNOPSIS
  Uninstall the HALOFLUX WorkBuddy adapter (MCP server entry).
.DESCRIPTION
  Restores the byte-identical pre-install mcp.json recorded in the manifest. If the
  file changed after install, removes only the `haloflux-status` server and keeps
  every other MCP server.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
#>
[CmdletBinding()]
param(
  [string]$BackupRoot,
  [string]$Manifest,
  [string]$NodePath,
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
$arguments = @($installer, 'workbuddy', '--action', 'uninstall')
if ($BackupRoot) { $arguments += @('--backup-root', $BackupRoot) }
if ($Manifest)   { $arguments += @('--manifest', $Manifest) }
if ($DryRun)     { $arguments += '--dry-run' }
if ($Json)       { $arguments += '--json' }
& $NodePath @arguments
exit $LASTEXITCODE
