<#
.SYNOPSIS
  HALOFLUX generic adapter - nothing to uninstall.
.DESCRIPTION
  The generic adapter never writes host configuration. This script only clears the
  watcher offset file if one exists (no host file is touched).
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
#>
[CmdletBinding()]
param([switch]$Json)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$stateFile = Join-Path $here '..\_shared\.watch-state\generic.json'
$removed = $false
if (Test-Path $stateFile) { Remove-Item $stateFile -Force; $removed = $true }
$result = [ordered]@{ host = 'generic'; status = 'NOTHING-TO-UNINSTALL'; stateFileRemoved = $removed }
if ($Json) { $result | ConvertTo-Json -Depth 4 } else { Write-Host 'HALOFLUX generic adapter: no host config to remove.' }
exit 0
