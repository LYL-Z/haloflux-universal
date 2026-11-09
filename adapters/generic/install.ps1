<#
.SYNOPSIS
  HALOFLUX generic adapter - nothing to install.
.DESCRIPTION
  The generic adapter is host-agnostic: it reads HALOFLUX v1 events (or a small
  shorthand) as JSONL on stdin and POSTs them to the loopback bridge. No host
  config file is touched, so there is deliberately nothing to install.
.EXAMPLE
  '{"eventType":"tool.start","toolName":"Bash"}' | node adapters\generic\adapter.mjs
.EXAMPLE
  node adapters\generic\adapter.mjs --file events.jsonl --host codex
#>
[CmdletBinding()]
param(
  [string]$NodePath,
  [switch]$Json
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { Write-Error 'node.exe not found on PATH; pass -NodePath.'; exit 1 }
  $NodePath = $cmd.Source
}
$result = [ordered]@{
  host        = 'generic'
  status      = 'NO-INSTALL-NEEDED'
  adapter     = (Join-Path $here 'adapter.mjs')
  nodePath    = $NodePath
  explanation = 'stdin JSONL adapter; no host configuration to merge'
}
if ($Json) { $result | ConvertTo-Json -Depth 4 } else {
  Write-Host 'HALOFLUX generic adapter: no installation needed.'
  Write-Host "  adapter : $($result.adapter)"
  Write-Host '  usage   : <host-script> | node adapter.mjs'
  Write-Host '  note    : shorthand records are downgraded to source=derived; full v1 events pass through'
}
exit 0
