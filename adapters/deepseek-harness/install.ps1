<#
.SYNOPSIS
  Install the HALOFLUX DeepSeek Harness bridge bundle (and optionally the
  upstream dsh-haloflux visual plugin) into a DSH profile.

.DESCRIPTION
  Two supported install paths:

    A. Agent tool `plugin_manager install_bundle target=<bundle dir>`
       (what this repository used for the verified install; link-based, the
       bundle directory stays the source of truth).

    B. This script: copies the bundle into <profile>\node_modules, edits only
       package.json (dependencies + dsh.profile.bundles), backs up every file it
       touches, and prints a rollback command. Use this when the agent tool is
       unavailable or the GUI must not be touched.

  The script never edits `cordis.patch.yml`; settings overrides belong to the
  user layer. Run with -DryRun to see the plan without changing anything.

.PARAMETER ProfileDir
  Profile directory. Defaults to $env:DSH_PROFILE_DIR, then
  $env:DSH_HOME\profiles\desktop.

.PARAMETER BundleDir
  Directory of this bundle. Defaults to ..\haloflux-bridge next to this script.

.PARAMETER WithVisualPlugin
  Also install upstream dsh-haloflux (visual only, no event bridge) from
  -VisualPluginDir. Optional: the visual plugin is normally installed with
  plugin_manager.

.PARAMETER DryRun
  Print planned actions; do not modify the profile.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = '',
    [string]$BundleDir = '',
    [switch]$WithVisualPlugin,
    [string]$VisualPluginDir = 'D:\HALOFLUX\upstream\dsh-haloflux',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$StartedAt = Get-Date
$Timestamp = $StartedAt.ToString('yyyyMMdd-HHmmss')
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
if (-not $BundleDir) { $BundleDir = Join-Path $ScriptDir 'haloflux-bridge' }

$ProfileDir = [IO.Path]::GetFullPath($ProfileDir)
$BundleDir = [IO.Path]::GetFullPath($BundleDir)

if (-not (Test-Path $ProfileDir)) { Fail "profile directory not found: $ProfileDir" }
if (-not (Test-Path (Join-Path $ProfileDir 'package.json'))) { Fail "missing profile manifest: $(Join-Path $ProfileDir 'package.json')" }
if (-not (Test-Path (Join-Path $BundleDir 'package.json'))) { Fail "missing bundle manifest: $(Join-Path $BundleDir 'package.json')" }

$bundleManifest = Get-Content (Join-Path $BundleDir 'package.json') -Raw | ConvertFrom-Json
if ($bundleManifest.name -ne $BundleName) { Fail "bundle package name is '$($bundleManifest.name)', expected '$BundleName'" }
if (-not $bundleManifest.dsh.bundle.patch) { Fail 'bundle package.json has no dsh.bundle.patch' }

$BackupRoot = Join-Path $ScriptDir ('backups\' + $Timestamp)
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { Fail 'node.exe not found on PATH' }
$ManifestTool = Join-Path $ScriptDir 'tools\profile-manifest.mjs'
if (-not (Test-Path $ManifestTool)) { Fail "missing manifest helper: $ManifestTool" }

Write-Step "profile  : $ProfileDir"
Write-Step "bundle   : $BundleDir"
Write-Step "backup   : $BackupRoot"
Write-Step "dry run  : $($DryRun.IsPresent)"

$FilesToBackup = @('package.json', 'cordis.patch.yml', 'cordis.yml')
$backupEntries = @()
if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
    foreach ($name in $FilesToBackup) {
        $source = Join-Path $ProfileDir $name
        if (Test-Path $source) {
            Copy-Item $source (Join-Path $BackupRoot $name) -Force
            $hash = (Get-FileHash $source -Algorithm SHA256).Hash
            $backupEntries += [ordered]@{ file = $name; sha256 = $hash; bytes = (Get-Item $source).Length }
        }
    }
    $manifest = [ordered]@{
        createdAt = $StartedAt.ToString('o')
        profileDir = $ProfileDir
        bundleDir = $BundleDir
        files = $backupEntries
        action = 'install'
    }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $BackupRoot 'manifest.json') -Encoding utf8
}

$target = Join-Path $ProfileDir ('node_modules\' + $BundleName)
$plan = @()
$plan += "copy $BundleDir -> $target"
$plan += "node tools\profile-manifest.mjs add `"$ProfileDir`" $BundleName `"file:$($BundleDir.Replace('\','/'))`""
if ($WithVisualPlugin) {
    if (-not (Test-Path (Join-Path $VisualPluginDir 'package.json'))) { Fail "visual plugin not found: $VisualPluginDir" }
    $plan += "copy $VisualPluginDir -> $(Join-Path $ProfileDir ('node_modules\' + $VisualName))"
    $plan += "node tools\profile-manifest.mjs add `"$ProfileDir`" $VisualName `"file:$($VisualPluginDir.Replace('\','/'))`""
}
Write-Step 'planned actions:'
$plan | ForEach-Object { Write-Host "  - $_" }

if ($DryRun) {
    Write-Step 'dry run complete; no changes made.'
    exit 0
}

function Install-BundleDirectory([string]$Source, [string]$Name) {
    $dest = Join-Path $ProfileDir ('node_modules\' + $Name)
    if (Test-Path $dest) {
        $item = Get-Item $dest -Force
        $isLink = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
        if ($isLink) {
            $linkTarget = ''
            try { $linkTarget = [string]$item.Target } catch { $linkTarget = '' }
            $sameTarget = $false
            if ($linkTarget) {
                try { $sameTarget = ([IO.Path]::GetFullPath($linkTarget).TrimEnd('\') -eq [IO.Path]::GetFullPath($Source).TrimEnd('\')) } catch { $sameTarget = $false }
            }
            if ($sameTarget) {
                Write-Step "kept existing link: $dest -> $linkTarget"
                return $dest
            }
            Write-Step "removing existing link: $dest -> $linkTarget"
            # rmdir removes a junction/symlink itself, never the target tree.
            & cmd.exe /c rmdir "$dest" | Out-Null
            if (Test-Path $dest) { Fail "could not remove link: $dest" }
        } else {
            $existingName = ''
            $existingPkg = Join-Path $dest 'package.json'
            if (Test-Path $existingPkg) {
                try { $existingName = (Get-Content $existingPkg -Raw | ConvertFrom-Json).name } catch { $existingName = '' }
            }
            if ($existingName -ne $Name -and $existingName -ne '') {
                Fail "refusing to remove $dest (package name '$existingName')"
            }
            Write-Step "replacing existing copy: $dest"
            Remove-Item $dest -Recurse -Force
        }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
    Copy-Item $Source $dest -Recurse -Force
    Write-Step "copied $Name -> $dest"
    return $dest
}

try {
    Install-BundleDirectory $BundleDir $BundleName | Out-Null
    $spec = 'file:' + ($BundleDir.Replace('\','/'))
    $addResult = & $NodeExe $ManifestTool add $ProfileDir $BundleName $spec
    if ($LASTEXITCODE -ne 0) { throw "manifest editor failed for $BundleName" }
    Write-Step "manifest: $addResult"

    if ($WithVisualPlugin) {
        Install-BundleDirectory $VisualPluginDir $VisualName | Out-Null
        $visualSpec = 'file:' + ($VisualPluginDir.Replace('\','/'))
        $visualResult = & $NodeExe $ManifestTool add $ProfileDir $VisualName $visualSpec
        if ($LASTEXITCODE -ne 0) { throw "manifest editor failed for $VisualName" }
        Write-Step "manifest: $visualResult"
    }

    $after = Get-ChildItem $ProfileDir -File | Where-Object { $FilesToBackup -contains $_.Name }
    $afterManifest = @()
    foreach ($file in $after) {
        $afterManifest += [ordered]@{ file = $file.Name; sha256 = (Get-FileHash $file.FullName -Algorithm SHA256).Hash; bytes = $file.Length }
    }
    $afterManifest | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $BackupRoot 'after.json') -Encoding utf8

    Write-Step 'install complete.'
    Write-Step "backup   : $BackupRoot"
    Write-Step 'restart the DSH desktop app (or reload the profile) so the Host loads the new bundle.'
    Write-Step "rollback : powershell -ExecutionPolicy Bypass -File `"$(Join-Path $ScriptDir 'uninstall.ps1')`" -Rollback `"$BackupRoot`""
    exit 0
} catch {
    Write-Host "[haloflux] ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if (Test-Path $BackupRoot) {
        Write-Step "restoring files from $BackupRoot"
        foreach ($entry in $backupEntries) {
            Copy-Item (Join-Path $BackupRoot $entry.file) (Join-Path $ProfileDir $entry.file) -Force
        }
    }
    exit 1
}
