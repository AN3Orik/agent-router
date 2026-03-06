Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PluginName = "co-yes-auth"
$TargetRoot = "$env:USERPROFILE\.config\opencode\plugins"
$ConfigDir = "$env:USERPROFILE\.config\opencode"
$TargetDir = Join-Path $TargetRoot $PluginName
$LegacyNodeModulesDir = "$env:USERPROFILE\.config\opencode\node_modules\opencode-yescode-auth"

function Write-FileUtf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Get-ConfigPath {
    param([string]$Dir)
    $jsonc = Join-Path $Dir "opencode.jsonc"
    $json = Join-Path $Dir "opencode.json"
    if (Test-Path $jsonc) { return $jsonc }
    if (Test-Path $json) { return $json }
    return ""
}

function Remove-YescodeProvider {
    param([string]$Raw)

    if ($Raw -notmatch '"yescode"\s*:') {
        return $Raw
    }

    $pattern = '"yescode"\s*:\s*\{(?:[^{}]|(?<o>\{)|(?<-o>\}))*\}(?(o)(?!))'
    $updated = [regex]::Replace($Raw, $pattern, "", 1)
    $updated = [regex]::Replace($updated, ',\s*}', "}")
    $updated = [regex]::Replace($updated, '\{\s*,', "{")
    return $updated
}

function Remove-PluginRegistration {
    param([string]$Raw)

    if ($Raw -notmatch '"plugin"\s*:') {
        return $Raw
    }

    $updated = [regex]::Replace(
        $Raw,
        '(?im)^\s*"file://[^"\r\n]*co-yes-auth[^"\r\n]*"\s*,?\s*$',
        ""
    )
    $updated = [regex]::Replace(
        $updated,
        '(?im)^\s*"[^"\r\n]*(co-yes-auth|opencode-yescode-auth)[^"\r\n]*"\s*,?\s*$',
        ""
    )
    $updated = [regex]::Replace(
        $updated,
        '(?im)^\s*"[^"\r\n]*yescode\.mjs[^"\r\n]*"\s*,?\s*$',
        ""
    )
    $updated = [regex]::Replace($updated, ',\s*]', "]")
    return $updated
}

$configPath = Get-ConfigPath -Dir $ConfigDir
if ($configPath) {
    $raw = Get-Content -Path $configPath -Raw
    $next = Remove-YescodeProvider -Raw $raw
    $next = Remove-PluginRegistration -Raw $next
    Write-FileUtf8NoBom -Path $configPath -Content $next
    Write-Output "[OK] Removed provider.yescode and plugin entry from $configPath"
}

if (Test-Path $TargetDir) {
    try {
        Get-ChildItem -Recurse -Force $TargetDir -ErrorAction SilentlyContinue | ForEach-Object {
            try {
                $_.Attributes = $_.Attributes -band (-bnot [System.IO.FileAttributes]::ReadOnly)
            } catch {
                # Keep going; best effort before delete.
            }
        }
        Remove-Item -Recurse -Force $TargetDir
        Write-Output "[OK] Removed plugin '$PluginName' from $TargetDir"
    } catch {
        Write-Output "[WARN] Could not fully remove $TargetDir. Close OpenCode and run uninstall again."
    }
} else {
    Write-Output "[OK] Plugin '$PluginName' is not installed."
}

if (Test-Path $LegacyNodeModulesDir) {
    Remove-Item -Recurse -Force $LegacyNodeModulesDir
    Write-Output "[OK] Removed legacy plugin folder from $LegacyNodeModulesDir"
} else {
    Write-Output "[OK] Legacy node_modules plugin folder is not installed."
}
