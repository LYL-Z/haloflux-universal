<#
.SYNOPSIS
  HALOFLUX adapter doctor - installation, token, bridge, config drift, rollback.
.DESCRIPTION
  Read-only. For every host it reports:
    - install status + number of HALOFLUX entries in the host config
    - whether the config still matches the install manifest (drift detection)
    - whether the bridge token is readable (path only; the token is never printed)
    - whether the loopback bridge is online
    - the exact rollback command
  Exit code is 0 when a report was produced (an offline bridge is data, not an
  error). Use -Json for machine-readable output.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1
.EXAMPLE
  .\doctor.ps1 -Json | ConvertFrom-Json
.EXAMPLE
  .\doctor.ps1 -Hosts claude-code -ConfigRoot D:\HALOFLUX\tmp\claude-test
#>
[CmdletBinding()]
param(
  [switch]$Json,
  [string]$BackupRoot,
  [string]$NodePath,
  [string]$Hosts,
  [string]$ConfigRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$doctor = Join-Path $repoRoot 'adapters\_shared\doctor.mjs'
if (-not (Test-Path $doctor)) { Write-Error "doctor.mjs not found: $doctor"; exit 1 }
if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { Write-Error 'node.exe not found on PATH; pass -NodePath.'; exit 1 }
  $NodePath = $cmd.Source
}

$arguments = @($doctor)
if ($Json)       { $arguments += '--json' }
if ($BackupRoot) { $arguments += @('--backup-root', $BackupRoot) }
if ($Hosts)      { $arguments += @('--hosts', $Hosts) }
if ($ConfigRoot) { $arguments += @('--config-root', $ConfigRoot) }

& $NodePath @arguments
exit $LASTEXITCODE
