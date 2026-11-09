<#
.SYNOPSIS
  Snapshot every host config file HALOFLUX may touch.

.EXAMPLE
  pwsh -File scripts\backup-config.ps1
  pwsh -File scripts\backup-config.ps1 -Label before-codex
#>
param([string]$Label = 'manual')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
& node scripts/haloflux.mjs backup --label $Label
exit $LASTEXITCODE
