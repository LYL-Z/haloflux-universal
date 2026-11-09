<#
.SYNOPSIS
  Install HALOFLUX host adapters (interactive by default).
.DESCRIPTION
  Default selection is Claude Code + Codex. Each host install performs:
  backup -> structured deep-merge -> atomic write -> manifest -> change report.
  Existing unrelated entries (e.g. AgentHaven hooks) are preserved.

  Safe automation flags: -Hosts/-All + -NonInteractive. For isolated testing use
  -ConfigRoot (single host) and -BackupRoot (temp dir); real user config is then
  never touched.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-adapters.ps1
.EXAMPLE
  .\install-adapters.ps1 -Hosts claude-code -ConfigRoot D:\HALOFLUX\tmp\claude-test -BackupRoot D:\HALOFLUX\tmp\backups -DryRun
.EXAMPLE
  .\install-adapters.ps1 -All -NonInteractive -BridgeUrl http://127.0.0.1:17817
#>
[CmdletBinding()]
param(
  [string[]]$Hosts,
  [switch]$All,
  [switch]$NonInteractive,
  [switch]$Json,
  [string]$BackupRoot,
  [string]$ConfigRoot,
  [string]$BridgeUrl,
  [string]$NodePath,
  [switch]$DryRun,
  [switch]$TraeHooks
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$supported = @('claude-code', 'codex', 'cursor', 'trae', 'workbuddy', 'generic')
$labels = @{
  'claude-code' = 'Claude Code'
  'codex'       = 'Codex'
  'cursor'      = 'Cursor'
  'trae'        = 'TRAE CN'
  'workbuddy'   = 'WorkBuddy'
  'generic'     = 'Generic (stdin JSONL)'
}

if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { Write-Error 'node.exe not found on PATH; pass -NodePath.'; exit 1 }
  $NodePath = $cmd.Source
}

# ---------------------------------------------------------------- selection
if (-not $Hosts -and -not $All) {
  $interactive = -not $NonInteractive -and $env:HALOFLUX_NONINTERACTIVE -ne '1' -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
  if (-not $interactive) {
    $Hosts = @('claude-code', 'codex')
    Write-Host 'Non-interactive: defaulting to Claude Code + Codex.' -ForegroundColor DarkGray
  } else {
    Write-Host 'HALOFLUX adapter installer' -ForegroundColor Cyan
    Write-Host 'Available hosts:'
    for ($i = 0; $i -lt $supported.Count; $i++) {
      Write-Host ("  [{0}] {1,-10} {2}" -f ($i + 1), $supported[$i], $labels[$supported[$i]])
    }
    $answer = Read-Host 'Select hosts by number (comma separated, Enter = 1,2 default Claude Code + Codex)'
    if ([string]::IsNullOrWhiteSpace($answer)) { $Hosts = @('claude-code', 'codex') } else {
      $Hosts = @()
      foreach ($token in ($answer -split ',')) {
        $n = 0
        if ([int]::TryParse($token.Trim(), [ref]$n) -and $n -ge 1 -and $n -le $supported.Count) {
          $Hosts += $supported[$n - 1]
        } else { Write-Warning "Ignoring invalid selection '$token'" }
      }
    }
  }
} elseif ($All) {
  $Hosts = $supported
}

$Hosts = @($Hosts | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ } | Select-Object -Unique)
foreach ($hostId in $Hosts) {
  if ($supported -notcontains $hostId) { Write-Error "Unsupported host '$hostId'. Supported: $($supported -join ', ')"; exit 1 }
}
if ($ConfigRoot -and $Hosts.Count -gt 1) {
  Write-Error '-ConfigRoot is only meaningful for a single host (each host has its own config root). Install them one at a time for isolated testing.'
  exit 1
}

# ---------------------------------------------------------------- execution
$results = @()
$failed = 0
foreach ($hostId in $Hosts) {
  $script = Join-Path $repoRoot "adapters\$hostId\install.ps1"
  if (-not (Test-Path $script)) { Write-Warning "Missing installer for $hostId ($script)"; $failed++; continue }
  $params = @{ NodePath = $NodePath; Json = $true }
  if ($BackupRoot) { $params['BackupRoot'] = $BackupRoot }
  if ($ConfigRoot) { $params['ConfigRoot'] = $ConfigRoot }
  if ($BridgeUrl)  { $params['BridgeUrl'] = $BridgeUrl }
  if ($DryRun)     { $params['DryRun'] = $true }
  if ($hostId -eq 'trae' -and $TraeHooks) { $params['Mode'] = 'Hooks' }

  Write-Host ("`n=== {0} ({1}) ===" -f $labels[$hostId], $hostId) -ForegroundColor Cyan
  $raw = & $script @params 2>&1
  $code = $LASTEXITCODE
  $rawText = ($raw | Out-String).Trim()
  $parsed = $null
  try { $parsed = $rawText | ConvertFrom-Json } catch { }
  if ($code -ne 0) {
    $failed++
    Write-Host $rawText -ForegroundColor Red
    $results += [pscustomobject]@{ Host = $hostId; Status = 'FAILED'; Detail = $rawText }
  } elseif ($parsed) {
    Write-Host ("status={0} added={1} removed={2} config={3}" -f $parsed.status, $parsed.added, $parsed.removed, $parsed.configPath)
    if ($parsed.backupDir) { Write-Host ("backup={0}" -f $parsed.backupDir) -ForegroundColor DarkGray }
    $results += [pscustomobject]@{ Host = $hostId; Status = $parsed.status; Detail = $parsed.configPath; Added = $parsed.added; Backup = $parsed.backupDir }
  } else {
    Write-Host $rawText
    $results += [pscustomobject]@{ Host = $hostId; Status = 'OK'; Detail = '' }
  }
}

Write-Host "`n=== summary ===" -ForegroundColor Cyan
$results | Format-Table -AutoSize
if ($Json) { $results | ConvertTo-Json -Depth 5 }
if ($failed -gt 0) { exit 1 }
exit 0
