<#
.SYNOPSIS
  Uninstall the HALOFLUX Claude Code adapter.
.DESCRIPTION
  Restores the byte-identical pre-install backup recorded in the manifest. If the
  host config changed after install, removes only HALOFLUX entries and reports the
  drift instead of clobbering unrelated changes.
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
$arguments = @($installer, 'claude-code', '--action', 'uninstall')
if ($BackupRoot) { $arguments += @('--backup-root', $BackupRoot) }
if ($Manifest)   { $arguments += @('--manifest', $Manifest) }
if ($DryRun)     { $arguments += '--dry-run' }
if ($Json)       { $arguments += '--json' }
& $NodePath @arguments
exit $LASTEXITCODE