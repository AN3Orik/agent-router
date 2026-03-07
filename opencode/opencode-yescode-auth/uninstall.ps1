Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PluginName = "opencode-yescode-auth"
$TargetRoot = "$env:USERPROFILE\.config\opencode\plugins"
$ConfigDir = "$env:USERPROFILE\.config\opencode"
$TargetDir = Join-Path $TargetRoot $PluginName
$TargetPrefix = "$PluginName-"
$LegacyNodeModulesDir = "$env:USERPROFILE\.config\opencode\node_modules\opencode-yescode-auth"

function Write-FileUtf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Clear-ReadOnlyRecursive {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        return
    }

    try {
        Get-ChildItem -Recurse -Force $Path -ErrorAction SilentlyContinue | ForEach-Object {
            try {
                $_.Attributes = $_.Attributes -band (-bnot [System.IO.FileAttributes]::ReadOnly)
            } catch {
                # Best effort.
            }
        }
    } catch {
        # Best effort.
    }
}

function Get-YescodeRelatedProcessIds {
    param([string]$TargetPath)

    $ids = New-Object System.Collections.Generic.HashSet[int]
    $normalized = ""
    if ($TargetPath) {
        try {
            $normalized = [System.IO.Path]::GetFullPath($TargetPath).ToLowerInvariant()
        } catch {
            $normalized = [string]$TargetPath
        }
    }

    try {
        $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'bun.exe' OR Name = 'opencode.exe'"
        foreach ($proc in $processes) {
            $pidValue = [int]$proc.ProcessId
            $cmd = [string]$proc.CommandLine
            if (-not $cmd) {
                continue
            }

            $cmdLower = $cmd.ToLowerInvariant()
            $isRelated =
                ($normalized -and $cmdLower.Contains($normalized)) -or
                $cmdLower.Contains("opencode-yescode-auth") -or
                $cmdLower.Contains("yescode-auth") -or
                $cmdLower.Contains("co-yes-auth") -or
                $cmdLower.Contains("agent-router")

            if ($isRelated) {
                [void]$ids.Add($pidValue)
            }
        }
    } catch {
        # Best effort.
    }

    return @($ids)
}

function Stop-YescodeRelatedProcesses {
    param([string]$TargetPath)

    $ids = @(Get-YescodeRelatedProcessIds -TargetPath $TargetPath)
    foreach ($pidValue in $ids) {
        try {
            Stop-Process -Id $pidValue -Force -ErrorAction Stop
            Write-Output "[INFO] Stopped process $pidValue that was locking plugin files."
        } catch {
            # Process may already be gone; continue.
        }
    }
}

function Remove-PathRobust {
    param(
        [string]$Path,
        [int]$RetryCount = 20,
        [int]$DelayMs = 250
    )

    if (-not (Test-Path $Path)) {
        return
    }

    for ($i = 0; $i -lt $RetryCount; $i++) {
        try {
            Clear-ReadOnlyRecursive -Path $Path
            Remove-Item -Recurse -Force $Path -ErrorAction Stop
            if (-not (Test-Path $Path)) {
                return
            }
        } catch {
            if ($i -eq 0 -or $i -eq 4 -or $i -eq 9) {
                Stop-YescodeRelatedProcesses -TargetPath $Path
            }
            Start-Sleep -Milliseconds $DelayMs
        }
    }

    throw "Failed to remove $Path. Another process still holds a lock."
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
        '(?im)^\s*"file://[^"\r\n]*(opencode-yescode-auth|yescode-auth|co-yes-auth)[^"\r\n]*"\s*,?\s*$',
        ""
    )
    $updated = [regex]::Replace(
        $updated,
        '(?im)^\s*"[^"\r\n]*(opencode-yescode-auth|yescode-auth|co-yes-auth)[^"\r\n]*"\s*,?\s*$',
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
        Remove-PathRobust -Path $TargetDir
        Write-Output "[OK] Removed plugin '$PluginName' from $TargetDir"
    } catch {
        Write-Output "[WARN] Could not fully remove $TargetDir. Close OpenCode and run uninstall again."
    }
} else {
    Write-Output "[OK] Plugin '$PluginName' is not installed."
}

if (Test-Path $TargetRoot) {
    $versionedDirs = Get-ChildItem -Path $TargetRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$TargetPrefix*" }
    foreach ($dir in $versionedDirs) {
        try {
            Remove-PathRobust -Path $dir.FullName
            Write-Output "[OK] Removed versioned plugin folder $($dir.FullName)"
        } catch {
            Write-Output "[WARN] Could not fully remove $($dir.FullName). Close OpenCode and run uninstall again."
        }
    }
}

if (Test-Path $LegacyNodeModulesDir) {
    Remove-PathRobust -Path $LegacyNodeModulesDir
    Write-Output "[OK] Removed legacy plugin folder from $LegacyNodeModulesDir"
} else {
    Write-Output "[OK] Legacy node_modules plugin folder is not installed."
}
