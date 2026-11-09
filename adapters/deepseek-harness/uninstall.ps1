<#
.SYNOPSIS
  Uninstall the HALOFLUX DeepSeek Harness bridge bundle, or roll back to a
  backup produced by install.ps1.

.DESCRIPTION
  Normal mode removes only this integration's rows:
    - `dependencies.dsh-haloflux-bridge` (and optionally `dsh-haloflux`)
    - `dsh.profile.bundles` entries for those names
    - the copied bundle directory in <profile>\node_modules (links are unlinked,
      never followed into the source tree)

  Rollback mode (-Rollback <backup dir>) restores package.json,
  cordis.patch.yml and cordis.yml byte-for-byte from the recorded backup and
  verifies every SHA256 from manifest.json before writing.

.PARAMETER Rollback
  Backup directory created by install.ps1.

.PARAMETER WithVisualPlugin
  Also remove upstream dsh-haloflux from the profile (the source checkout under
  D:\HALOFLUX\upstream is never touched).

.PARAMETER DryRun
  Print planned actions; do not modify the profile.
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = '',
    [string]$Rollback = '',
    [switch]$WithVisualPlugin,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$BundleName = 'dsh-haloflux-bridge'
$VisualName = 'dsh-haloflux'

function Write-Step([string]$Text) { Write-Host "[haloflux] $Text" }
function Fail([string]$Text) { Write-Host "[haloflux] ERROR: $Text" -ForegroundColor Red; exit 1 }

if (-not $ProfileDir) {
    if ($env:DSH_PROFILE_DIR) { $ProfileDir = $env:DSH_PROFILE_DIR }
    elseif ($env:DSH_HOME) { $ProfileDir = Join-Path $env:DSH_HOME 'profiles\desktop' }
    else { $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
}
$ProfileDir = [IO.Path]::GetFullPath($ProfileDir)
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { Fail 'node.exe not found on PATH' }
$ManifestTool = Join-Path $ScriptDir 'tools\profile-manifest.mjs'

if ($Rollback) {
    $Rollback = [IO.Path]::GetFullPath($Rollback)
    $manifestPath = Join-Path $Rollback 'manifest.json'
    if (-not (Test-Path $manifestPath)) { Fail "missing rollback manifest: $manifestPath" }
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if (-not $manifest.files) { Fail 'rollback manifest has no files list' }
    Write-Step "rollback : $Rollback"
    Write-Step "profile  : $ProfileDir"
    foreach ($entry in $manifest.files) {
        $source = Join-Path $Rollback $entry.file
        if (-not (Test-Path $source)) { Fail "backup file missing: $source" }
        $hash = (Get-FileHash $source -Algorithm SHA256).Hash
        if ($hash -ne $entry.sha256) { Fail "backup hash mismatch for $($entry.file): $hash" }
        $target = Join-Path $ProfileDir $entry.file
        if ($DryRun) {
            Write-Step "would restore $source -> $target (sha256 verified)"
        } else {
            Copy-Item $source $target -Force
            $restored = (Get-FileHash $target -Algorithm SHA256).Hash
            if ($restored -ne $entry.sha256) { Fail "restored hash mismatch for $($entry.file)" }
            Write-Step "restored $($entry.file) (sha256 ok)"
        }
    }
    if ($DryRun) { Write-Step 'dry run complete; no changes made.' }
    else {
        Write-Step 'rollback complete. Restart DSH to unload the bundle.'
        Write-Step 'note: bundle directories copied under node_modules are NOT removed by rollback; use normal uninstall for those.'
    }
    exit 0
}

if (-not (Test-Path (Join-Path $ProfileDir 'package.json'))) { Fail "missing profile manifest: $(Join-Path $ProfileDir 'package.json')" }
if (-not (Test-Path $ManifestTool)) { Fail "missing manifest helper: $ManifestTool" }

$targets = @($BundleName)
if ($WithVisualPlugin) { $targets += $VisualName }

Write-Step "profile  : $ProfileDir"
Write-Step "targets  : $($targets -join ', ')"
Write-Step "dry run  : $($DryRun.IsPresent)"

$plan = @()
foreach ($name in $targets) {
    $dest = Join-Path $ProfileDir ('node_modules\' + $name)
    $plan += "node tools\profile-manifest.mjs remove `"$ProfileDir`" $name"
    $plan += "remove bundle directory/link if present: $dest"
}
$plan | ForEach-Object { Write-Host "  - $_" }
if ($DryRun) {
    Write-Step 'dry run complete; no changes made.'
    exit 0
}

$backupDir = Join-Path $ScriptDir ('backups\uninstall-' + (Get-Date).ToString('yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
foreach ($file in @('package.json', 'cordis.patch.yml', 'cordis.yml')) {
    $source = Join-Path $ProfileDir $file
    if (Test-Path $source) { Copy-Item $source (Join-Path $backupDir $file) -Force }
}
@{
    createdAt = (Get-Date).ToString('o')
    profileDir = $ProfileDir
    targets = $targets
    action = 'uninstall-before'
} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $backupDir 'manifest.json') -Encoding utf8

try {
    foreach ($name in $targets) {
        $removeResult = & $NodeExe $ManifestTool remove $ProfileDir $name
        if ($LASTEXITCODE -ne 0) { throw "manifest editor failed for $name" }
        Write-Step "manifest: $removeResult"

        $dest = Join-Path $ProfileDir ('node_modules\' + $name)
        if (Test-Path $dest) {
            $item = Get-Item $dest -Force
            $isLink = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
            if ($isLink) {
                # rmdir removes a junction/symlink itself, never the target tree.
                & cmd.exe /c rmdir "$dest" | Out-Null
                Write-Step "removed link: $dest"
            } else {
                $existingName = ''
                $existingPkg = Join-Path $dest 'package.json'
                if (Test-Path $existingPkg) {
                    try { $existingName = (Get-Content $existingPkg -Raw | ConvertFrom-Json).name } catch { $existingName = '' }
                }
                if ($existingName -ne $name) {
                    Write-Step "skipped removal of $dest (package name '$existingName' does not match)"
                } else {
                    Remove-Item $dest -Recurse -Force
                    Write-Step "removed copy: $dest"
                }
            }
        }
    }
    Write-Step 'uninstall complete.'
    Write-Step "pre-uninstall backup: $backupDir"
    Write-Step 'restart DSH to unload the bundle.'
    exit 0
} catch {
    Write-Host "[haloflux] ERROR: $($_.Exception.Message)" -ForegroundColor Red
    foreach ($file in @('package.json', 'cordis.patch.yml', 'cordis.yml')) {
        if (Test-Path (Join-Path $backupDir $file)) {
            Copy-Item (Join-Path $backupDir $file) (Join-Path $ProfileDir $file) -Force
            Write-Step "restored $file from $backupDir"
        }
    }
    exit 1
}
