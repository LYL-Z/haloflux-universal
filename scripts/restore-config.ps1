<#
.SYNOPSIS
  Restore a previously snapshotted host config set.

.EXAMPLE
  pwsh -File scripts\restore-config.ps1 -Timestamp 2026-11-08T15-50-00-000Z-install
  pwsh -File scripts\restore-config.ps1 -Timestamp install -DryRun
#>
param(
  [Parameter(Mandatory = $true)][string]$Timestamp,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$argsList = @('scripts/haloflux.mjs', 'restore', $Timestamp)
if ($DryRun) { $argsList += '--dry-run' }
& node @argsList
exit $LASTEXITCODE
