<#
.SYNOPSIS
  HALOFLUX Universal Agent Visualizer — uninstall / rollback.

.DESCRIPTION
  Reverses what install.ps1 did, in reverse order:
    1. stops bridge and desktop companion;
    2. runs scripts/uninstall-adapters.ps1 (removes only the hook/MCP entries this
       project added, restoring every touched host config from its backup);
    3. removes the Start Menu shortcut and generated launchers;
    4. optionally deletes local data (%LOCALAPPDATA%\HALOFLUX: token, logs, pid files).

  The project directory itself is never deleted. Config backups stay under
  config/backups so a manual rollback remains possible.

.PARAMETER PurgeData
  Delete %LOCALAPPDATA%\HALOFLUX (token, logs, run state).

.PARAMETER RestoreBackup
  Timestamp/prefix of a config backup to restore after adapter removal, e.g. 2026-11-08T15-50-00-000Z-install.

.PARAMETER Yes
  Do not prompt.
#>
[CmdletBinding()]
param(
  [switch]$PurgeData,
  [string]$RestoreBackup,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Write-Step([string]$Text) { Write-Host "`n== $Text ==" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  OK   $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "  WARN $Text" -ForegroundColor Yellow }

Write-Host 'HALOFLUX uninstall' -ForegroundColor Magenta
if (-not $Yes) {
  $answer = Read-Host 'This removes HALOFLUX hooks from installed agents (configs are restored from backup). Continue? [y/N]'
  if ($answer -notmatch '^(y|yes)$') { Write-Host 'aborted'; exit 0 }
}

Write-Step '1/4 stop processes'
& node scripts/haloflux.mjs stop | Out-Host

Write-Step '2/4 host adapters'
if (Test-Path 'scripts\uninstall-adapters.ps1') {
  & powershell -NoProfile -ExecutionPolicy Bypass -File 'scripts\uninstall-adapters.ps1' | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Warn 'adapter uninstaller reported a problem; verify host configs manually' }
} else {
  Write-Warn 'scripts\uninstall-adapters.ps1 missing - using per-host uninstallers'
  foreach ($hostId in @('claude-code', 'codex', 'cursor', 'workbuddy', 'trae')) {
    $installer = Join-Path $Root "adapters\$hostId\uninstall.ps1"
    if (Test-Path $installer) {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $installer -Json | Out-Host
      if ($LASTEXITCODE -ne 0) { Write-Warn "$hostId uninstaller returned $LASTEXITCODE" }
    }
  }
}

if ($RestoreBackup) {
  Write-Step "restoring config backup: $RestoreBackup"
  & node scripts/haloflux.mjs restore $RestoreBackup | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Warn 'restore reported a problem' }
}

Write-Step '3/4 shortcuts and launchers'
$manifestPath = Join-Path $Root 'config\install-manifest.json'
if (Test-Path $manifestPath) {
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.shortcut -and (Test-Path $manifest.shortcut)) {
    Remove-Item $manifest.shortcut -Force
    Write-Ok "removed shortcut $($manifest.shortcut)"
  }
} else {
  $fallback = Join-Path ([Environment]::GetFolderPath('Programs')) 'HALOFLUX Universal Agent Visualizer.lnk'
  if (Test-Path $fallback) { Remove-Item $fallback -Force; Write-Ok "removed shortcut $fallback" }
}
foreach ($file in @('bin\HALOFLUX.cmd', 'bin\HALOFLUX-stop.cmd')) {
  $full = Join-Path $Root $file
  if (Test-Path $full) { Remove-Item $full -Force; Write-Ok "removed $file" }
}
if (Test-Path $manifestPath) { Remove-Item $manifestPath -Force }

Write-Step '4/4 local data'
$homeDir = if ($env:HALOFLUX_HOME) { $env:HALOFLUX_HOME } else { Join-Path $env:LOCALAPPDATA 'HALOFLUX' }
if ($PurgeData) {
  if (Test-Path $homeDir) { Remove-Item $homeDir -Recurse -Force; Write-Ok "deleted $homeDir" }
  else { Write-Ok 'nothing to delete' }
} else {
  Write-Warn "kept local data at $homeDir (re-run with -PurgeData to delete)"
}

Write-Host "`nUninstall complete. Backups remain under config\backups for manual rollback." -ForegroundColor Green
Write-Host 'Project files were not deleted.' -ForegroundColor DarkGray
