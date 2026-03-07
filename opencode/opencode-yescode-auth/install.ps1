Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PluginName = "opencode-yescode-auth"
$ConfigDir = "$env:USERPROFILE\.config\opencode"
$AuthFilePath = Join-Path $env:USERPROFILE ".local\share\opencode\auth.json"
$SourceDir = $PSScriptRoot

function Get-ConfigPath {
    param([string]$Dir)
    $jsonc = Join-Path $Dir "opencode.jsonc"
    $json = Join-Path $Dir "opencode.json"
    if (Test-Path $jsonc) { return $jsonc }
    if (Test-Path $json) { return $json }
    return $jsonc
}

function To-FileUri {
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    return ([System.Uri]$full).AbsoluteUri
}

function Write-FileUtf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Resolve-FirstCommandPath {
    param([string[]]$Names)

    foreach ($name in $Names) {
        if (-not $name) {
            continue
        }
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) {
            if ($cmd.Source) { return [string]$cmd.Source }
            if ($cmd.Path) { return [string]$cmd.Path }
            return [string]$cmd.Name
        }
    }

    return ""
}

function Assert-RequiredCliTools {
    $requirements = @(
        [ordered]@{
            Label = "Codex ACP"
            Candidates = @("codex-acp", "codex-acp.cmd")
            Help = "& { `$base='https://co.yes.vg'; iwr -useb `$base/setup-codex.ps1 | iex }"
        },
        [ordered]@{
            Label = "Claude ACP"
            Candidates = @("claude-code-acp", "claude-code-acp.cmd")
            Help = "& { `$base='https://co.yes.vg'; iwr -useb `$base/setup-claude-code.ps1 | iex }"
        },
        [ordered]@{
            Label = "Gemini CLI (ACP mode)"
            Candidates = @("gemini", "gemini.cmd")
            Help = "& { `$base='https://co.yes.vg'; iwr -useb `$base/setup_gemini.ps1 | iex }"
        }
    )

    $missing = New-Object System.Collections.Generic.List[object]
    foreach ($item in $requirements) {
        $resolved = Resolve-FirstCommandPath -Names $item.Candidates
        if (-not $resolved) {
            [void]$missing.Add($item)
        } else {
            Write-Output "[OK] Found $($item.Label): $resolved"
        }
    }

    if ($missing.Count -gt 0) {
        $lines = New-Object System.Collections.Generic.List[string]
        [void]$lines.Add("Required CLI tools are missing. Install them and run install.ps1 again:")
        foreach ($item in $missing) {
            [void]$lines.Add("- $($item.Label):")
            [void]$lines.Add("  $($item.Help)")
        }
        throw ($lines -join "`r`n")
    }
}

function Stop-RunningYescodeRouters {
    try {
        $candidates = Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object {
                $_.Name -eq "node.exe" -and
                $_.CommandLine -and
                $_.CommandLine -match "(opencode-yescode-auth|yescode-auth|co-yes-auth)" -and
                $_.CommandLine -match "router" -and
                $_.CommandLine -match "server\.js"
            }

        $stopped = 0
        foreach ($proc in $candidates) {
            try {
                Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction Stop
                $stopped += 1
            } catch {
                Write-Output "[WARN] Failed to stop router process $($proc.ProcessId): $($_.Exception.Message)"
            }
        }

        if ($stopped -gt 0) {
            Write-Output "[OK] Stopped $stopped running yescode router process(es)."
            Start-Sleep -Milliseconds 500
        }
    } catch {
        Write-Output "[WARN] Could not inspect running router processes: $($_.Exception.Message)"
    }
}

function Remove-ExistingYescodePluginEntries {
    param([string]$Raw)

    $updated = [regex]::Replace(
        $Raw,
        '(?im)^\s*"[^"\r\n]*(opencode-yescode-auth|yescode-auth|co-yes-auth|yescode\.mjs)[^"\r\n]*"\s*,?\s*$',
        ""
    )
    $updated = [regex]::Replace($updated, ',\s*]', "]")
    return $updated
}

function Add-PluginRegistration {
    param(
        [string]$Raw,
        [string]$PluginSpecifier
    )

    $nextRaw = Remove-ExistingYescodePluginEntries -Raw $Raw
    if ($nextRaw -match [regex]::Escape($PluginSpecifier)) {
        return $nextRaw
    }

    $pluginValue = "`"$PluginSpecifier`""

    if ($nextRaw -match '"plugin"\s*:\s*\[\s*\]') {
        return [regex]::Replace(
            $nextRaw,
            '"plugin"\s*:\s*\[\s*\]',
            "`"plugin`": [`r`n    $pluginValue`r`n  ]",
            1
        )
    }

    if ($nextRaw -match '"plugin"\s*:\s*\[') {
        return [regex]::Replace(
            $nextRaw,
            '"plugin"\s*:\s*\[',
            "`"plugin`": [`r`n    $pluginValue,",
            1
        )
    }

    $trimmed = $nextRaw.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed -match '^\{\s*\}$') {
        return "{`r`n  `"$schema`": `"https://opencode.ai/config.json`",`r`n  `"plugin`": [`r`n    $pluginValue`r`n  ]`r`n}`r`n"
    }

    return [regex]::Replace(
        $nextRaw,
        '\}\s*$',
        ",`r`n  `"plugin`": [`r`n    $pluginValue`r`n  ]`r`n}",
        1
    )
}

function Add-YescodeProvider {
    param([string]$Raw)

    $canonicalProviderValue = @(
        '"yescode": {',
        '      "name": "YesCode",',
        '      "npm": "@ai-sdk/openai",',
        '      "options": {',
        '        "baseURL": "http://127.0.0.1:8787/v1"',
        '      }',
        '    }'
    ) -join "`r`n"

    if ($Raw -match '"yescode"\s*:') {
        $yescodePattern = '"yescode"\s*:\s*\{(?:[^{}]|(?<o>\{)|(?<-o>\}))*\}(?(o)(?!))'
        if ([regex]::IsMatch($Raw, $yescodePattern)) {
            return [regex]::Replace($Raw, $yescodePattern, $canonicalProviderValue, 1)
        }
    }

    $providerValue = $canonicalProviderValue

    if ($Raw -match '"provider"\s*:\s*\{\s*\}') {
        return [regex]::Replace(
            $Raw,
            '"provider"\s*:\s*\{\s*\}',
            "`"provider`": {`r`n    $providerValue`r`n  }",
            1
        )
    }

    if ($Raw -match '"provider"\s*:\s*\{') {
        return [regex]::Replace(
            $Raw,
            '"provider"\s*:\s*\{',
            "`"provider`": {`r`n    $providerValue,",
            1
        )
    }

    $trimmed = $Raw.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed -match '^\{\s*\}$') {
        return "{`r`n  `"$schema`": `"https://opencode.ai/config.json`",`r`n  `"provider`": {`r`n    $providerValue`r`n  }`r`n}`r`n"
    }

    return [regex]::Replace(
        $Raw,
        '\}\s*$',
        ",`r`n  `"provider`": {`r`n    $providerValue`r`n  }`r`n}",
        1
    )
}

function Get-YescodeApiKeyFromAuth {
    if (-not (Test-Path $AuthFilePath)) {
        return ""
    }

    $raw = Get-Content -Raw $AuthFilePath
    $auth = $raw | ConvertFrom-Json
    if ($auth.yescode -and $auth.yescode.type -eq "api" -and $auth.yescode.key) {
        return [string]$auth.yescode.key
    }

    return ""
}

function Wait-YescodeApiKeyFromAuth {
    param(
        [int]$RetryCount = 30,
        [int]$DelayMs = 500
    )

    for ($i = 0; $i -lt $RetryCount; $i++) {
        $key = Get-YescodeApiKeyFromAuth
        if ($key) {
            return $key
        }
        Start-Sleep -Milliseconds $DelayMs
    }

    return ""
}

function Invoke-JsonGetStrict {
    param(
        [string]$Uri,
        [hashtable]$Headers
    )

    try {
        return Invoke-RestMethod -Method Get -Uri $Uri -Headers $Headers -TimeoutSec 20
    } catch {
        throw "Request failed: $Uri ($($_.Exception.Message))"
    }
}

function Get-PropertyValue {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object -or -not $Name) {
        return $null
    }

    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) {
            return $Object[$Name]
        }
        return $null
    }

    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) {
        return $prop.Value
    }

    return $null
}

function Get-StringProperty {
    param(
        [object]$Object,
        [string]$Name
    )

    $value = Get-PropertyValue -Object $Object -Name $Name
    if ($null -eq $value) {
        return ""
    }

    $text = [string]$value
    if (-not $text) {
        return ""
    }

    return $text.Trim()
}

function Get-NullableBooleanProperty {
    param(
        [object]$Object,
        [string]$Name
    )

    $value = Get-PropertyValue -Object $Object -Name $Name
    if ($null -eq $value) {
        return $null
    }

    if ($value -is [bool]) {
        return [bool]$value
    }

    $text = [string]$value
    if ($text -match '^(?i:true|false)$') {
        return [bool]::Parse($text)
    }

    return $null
}

function Get-NullableNumberProperty {
    param(
        [object]$Object,
        [string]$Name
    )

    $value = Get-PropertyValue -Object $Object -Name $Name
    if ($null -eq $value) {
        return $null
    }

    try {
        return [double]$value
    } catch {
        return $null
    }
}

function Normalize-Modalities {
    param([object]$Value)

    $allowed = @{
        text = $true
        audio = $true
        image = $true
        video = $true
        pdf = $true
    }

    $result = New-Object System.Collections.Generic.List[string]
    foreach ($item in @($Value)) {
        if ($null -eq $item) {
            continue
        }

        $text = [string]$item
        if (-not $text) {
            continue
        }

        $key = $text.Trim().ToLowerInvariant()
        if (-not $key) {
            continue
        }

        if ($allowed.ContainsKey($key) -and -not $result.Contains($key)) {
            $result.Add($key)
        }
    }

    return @($result)
}

function Get-OfficialProviderFromText {
    param([string]$Text)

    if (-not $Text) {
        return ""
    }

    $value = $Text.ToLowerInvariant()
    if ($value -match '\bopenai\b') {
        return "openai"
    }
    if ($value -match '\banthropic\b') {
        return "anthropic"
    }
    if ($value -match '\bgoogle\b') {
        return "google"
    }

    return ""
}

function Infer-OfficialProviderFromModelId {
    param([string]$ModelId)

    if (-not $ModelId) {
        return ""
    }

    $id = $ModelId.Trim().ToLowerInvariant()
    if (-not $id) {
        return ""
    }

    if ($id -match '^(openai|anthropic|google)/') {
        return $matches[1]
    }
    if ($id.StartsWith("claude")) {
        return "anthropic"
    }
    if ($id.StartsWith("gemini")) {
        return "google"
    }
    if ($id.StartsWith("gpt") -or $id.StartsWith("o") -or $id.Contains("codex")) {
        return "openai"
    }

    return ""
}

function Get-ModelRefParts {
    param([string]$ModelId)

    $raw = [string]$ModelId
    if (-not $raw) {
        return [ordered]@{
            raw = ""
            base = ""
            provider = ""
        }
    }

    $raw = $raw.Trim()
    if (-not $raw) {
        return [ordered]@{
            raw = ""
            base = ""
            provider = ""
        }
    }

    $base = $raw
    $provider = ""
    $slash = $raw.IndexOf("/")
    if ($slash -gt 0 -and $slash -lt ($raw.Length - 1)) {
        $maybeProvider = $raw.Substring(0, $slash).Trim().ToLowerInvariant()
        $maybeBase = $raw.Substring($slash + 1).Trim()
        if ($maybeBase) {
            $base = $maybeBase
        }
        if (@("openai", "anthropic", "google") -contains $maybeProvider) {
            $provider = $maybeProvider
        }
    }

    return [ordered]@{
        raw = $raw
        base = $base
        provider = $provider
    }
}

function Get-ModelsDevIndex {
    $payload = Invoke-JsonGetStrict -Uri "https://models.dev/api.json" -Headers @{}
    if (-not $payload) {
        throw "models.dev returned empty payload."
    }

    $providerIndex = @{}
    $qualifiedIndex = @{}
    $byIdIndex = @{}
    $officialProviders = @("openai", "anthropic", "google")

    foreach ($providerId in $officialProviders) {
        $providerNode = Get-PropertyValue -Object $payload -Name $providerId
        if (-not $providerNode) {
            continue
        }

        $providerModels = Get-PropertyValue -Object $providerNode -Name "models"
        if (-not $providerModels) {
            continue
        }

        $map = @{}
        foreach ($prop in $providerModels.PSObject.Properties) {
            $modelId = [string]$prop.Name
            if (-not $modelId -or -not $modelId.Trim()) {
                continue
            }

            $key = $modelId.Trim().ToLowerInvariant()
            $meta = $prop.Value
            $map[$key] = $meta
            $qualifiedIndex["$providerId/$key"] = $meta

            if (-not $byIdIndex.ContainsKey($key)) {
                $byIdIndex[$key] = New-Object System.Collections.ArrayList
            }

            [void]$byIdIndex[$key].Add([ordered]@{
                provider = $providerId
                meta = $meta
            })
        }

        $providerIndex[$providerId] = $map
    }

    if ($providerIndex.Count -eq 0) {
        throw "models.dev does not expose official providers (openai/anthropic/google)."
    }

    return @{
        provider = $providerIndex
        qualified = $qualifiedIndex
        byId = $byIdIndex
    }
}

function Resolve-ModelsDevMeta {
    param(
        [hashtable]$Index,
        [string]$ModelId,
        [string]$ProviderHint
    )

    if (-not $Index -or -not $ModelId) {
        return $null
    }

    $parts = Get-ModelRefParts -ModelId $ModelId
    if (-not $parts.raw) {
        return $null
    }

    $rawKey = $parts.raw.ToLowerInvariant()
    if ($Index.qualified.ContainsKey($rawKey)) {
        $rawParts = Get-ModelRefParts -ModelId $parts.raw
        return [ordered]@{
            provider = $rawParts.provider
            meta = $Index.qualified[$rawKey]
        }
    }

    $baseKey = $parts.base.ToLowerInvariant()
    $providerCandidates = New-Object System.Collections.ArrayList
    $seen = @{}

    $candidateValues = @(
        $parts.provider,
        $ProviderHint,
        (Infer-OfficialProviderFromModelId -ModelId $parts.base),
        (Infer-OfficialProviderFromModelId -ModelId $parts.raw),
        "openai",
        "anthropic",
        "google"
    )
    foreach ($candidate in $candidateValues) {
        if (-not $candidate) {
            continue
        }
        $normalized = $candidate.Trim().ToLowerInvariant()
        if (-not $normalized) {
            continue
        }
        if ($seen.ContainsKey($normalized)) {
            continue
        }
        $seen[$normalized] = $true
        [void]$providerCandidates.Add($normalized)
    }

    foreach ($providerId in @($providerCandidates)) {
        $providerMap = Get-PropertyValue -Object $Index.provider -Name $providerId
        if ($providerMap -and $providerMap.ContainsKey($baseKey)) {
            return [ordered]@{
                provider = $providerId
                meta = $providerMap[$baseKey]
            }
        }
    }

    $matches = Get-PropertyValue -Object $Index.byId -Name $baseKey
    if ($matches -and $matches.Count -eq 1) {
        return [ordered]@{
            provider = $matches[0].provider
            meta = $matches[0].meta
        }
    }

    return $null
}

function Add-ReasoningEffortVariants {
    param(
        [string[]]$Efforts
    )

    $variants = [ordered]@{}
    foreach ($effort in @($Efforts)) {
        if (-not $effort) {
            continue
        }
        $key = $effort.Trim().ToLowerInvariant()
        if (-not $key) {
            continue
        }
        if (-not $variants.Contains($key)) {
            $variants[$key] = [ordered]@{
                reasoningEffort = $key
            }
        }
    }

    return $variants
}

function Get-OpenAiVariants {
    param(
        [string]$ModelId,
        [string]$ReleaseDate
    )

    $id = [string]$ModelId
    if (-not $id) {
        return [ordered]@{}
    }

    $normalizedId = $id.Trim().ToLowerInvariant()
    if (-not $normalizedId) {
        return [ordered]@{}
    }

    if ($normalizedId -eq "gpt-5-pro") {
        return [ordered]@{}
    }

    if ($normalizedId.Contains("codex")) {
        $efforts = @("low", "medium", "high")
        if ($normalizedId.Contains("5.2") -or $normalizedId.Contains("5.3")) {
            $efforts += "xhigh"
        }
        return Add-ReasoningEffortVariants -Efforts $efforts
    }

    $efforts = @("low", "medium", "high")
    if ($normalizedId.StartsWith("gpt-5-") -or $normalizedId -eq "gpt-5") {
        $efforts = @("minimal") + $efforts
    }

    if ($ReleaseDate -and $ReleaseDate -ge "2025-11-13") {
        $efforts = @("none") + $efforts
    }

    if ($ReleaseDate -and $ReleaseDate -ge "2025-12-04") {
        $efforts += "xhigh"
    }

    return Add-ReasoningEffortVariants -Efforts $efforts
}

function Get-AnthropicVariants {
    param([string]$ModelId)

    $id = [string]$ModelId
    if (-not $id) {
        return [ordered]@{}
    }

    $normalizedId = $id.Trim().ToLowerInvariant()
    if (-not $normalizedId) {
        return [ordered]@{}
    }

    if (
        $normalizedId.Contains("opus-4-6") -or
        $normalizedId.Contains("opus-4.6") -or
        $normalizedId.Contains("sonnet-4-6") -or
        $normalizedId.Contains("sonnet-4.6")
    ) {
        return Add-ReasoningEffortVariants -Efforts @("low", "medium", "high", "max")
    }

    return Add-ReasoningEffortVariants -Efforts @("high", "max")
}

function Get-GoogleVariants {
    param([string]$ModelId)

    $id = [string]$ModelId
    if (-not $id) {
        return [ordered]@{}
    }

    $normalizedId = $id.Trim().ToLowerInvariant()
    if (-not $normalizedId) {
        return [ordered]@{}
    }

    if ($normalizedId.Contains("gemini-2.5")) {
        return Add-ReasoningEffortVariants -Efforts @("high", "max")
    }

    if ($normalizedId.Contains("gemini-3.1")) {
        if ($normalizedId.Contains("pro")) {
            return Add-ReasoningEffortVariants -Efforts @("low", "high")
        }
        return Add-ReasoningEffortVariants -Efforts @("low", "medium", "high")
    }

    if ($normalizedId.Contains("gemini-3")) {
        return Add-ReasoningEffortVariants -Efforts @("low", "high")
    }

    return [ordered]@{}
}

function Get-VariantsForModel {
    param(
        [string]$ProviderId,
        [string]$ModelId,
        [string]$ReleaseDate,
        [bool]$ReasoningSupported
    )

    if (-not $ReasoningSupported) {
        return [ordered]@{}
    }

    $provider = [string]$ProviderId
    if (-not $provider) {
        return [ordered]@{}
    }
    $provider = $provider.Trim().ToLowerInvariant()

    if ($provider -eq "openai") {
        return Get-OpenAiVariants -ModelId $ModelId -ReleaseDate $ReleaseDate
    }
    if ($provider -eq "anthropic") {
        return Get-AnthropicVariants -ModelId $ModelId
    }
    if ($provider -eq "google") {
        return Get-GoogleVariants -ModelId $ModelId
    }

    return [ordered]@{}
}

function Apply-OpenCodeDefaultVariantDisables {
    param(
        [hashtable]$Variants,
        [bool]$ReasoningSupported
    )

    if (-not $ReasoningSupported) {
        return $Variants
    }

    if (-not $Variants) {
        $Variants = [ordered]@{}
    }

    # OpenCode auto-adds low/medium/high for openai-compatible providers.
    # Mark unsupported defaults as disabled so only model-valid variants stay visible.
    $defaultEfforts = @("low", "medium", "high")
    foreach ($effort in $defaultEfforts) {
        if (-not $Variants.Contains($effort)) {
            $Variants[$effort] = [ordered]@{
                disabled = $true
            }
        }
    }

    return $Variants
}

function Get-FallbackMetaFromCatalog {
    param(
        [string]$ModelId,
        [string]$ProviderId,
        [object]$CatalogItem
    )

    $id = [string]$ModelId
    if (-not $id) {
        return $null
    }
    $normalizedId = $id.Trim().ToLowerInvariant()
    if (-not $normalizedId) {
        return $null
    }

    $provider = [string]$ProviderId
    if (-not $provider) {
        $provider = Infer-OfficialProviderFromModelId -ModelId $normalizedId
    }
    if (-not $provider) {
        $provider = "google"
    }
    $provider = $provider.Trim().ToLowerInvariant()

    $inputPrice = Get-NullableNumberProperty -Object $CatalogItem -Name "input_token_price"
    $outputPrice = Get-NullableNumberProperty -Object $CatalogItem -Name "output_token_price"
    $cacheReadPrice = Get-NullableNumberProperty -Object $CatalogItem -Name "cache_read_token_price"

    $fallback = [ordered]@{}
    if ($provider -eq "google" -and $normalizedId.Contains("gemini-")) {
        $fallback.family = if ($normalizedId.Contains("pro")) { "gemini-pro" } else { "gemini-flash" }
        $fallback.attachment = $true
        $fallback.temperature = $true
        $fallback.tool_call = $true
        if ($normalizedId.Contains("2.5") -or $normalizedId.Contains("3")) {
            $fallback.reasoning = $true
        }
    }

    if ($null -ne $inputPrice -and $null -ne $outputPrice) {
        $cost = [ordered]@{
            input = $inputPrice
            output = $outputPrice
        }
        if ($null -ne $cacheReadPrice) {
            $cost.cache_read = $cacheReadPrice
        }
        $fallback.cost = $cost
    }

    if ($fallback.Count -eq 0) {
        return $null
    }

    return $fallback
}

function New-EnrichedModelFromCatalog {
    param(
        [object]$CatalogItem,
        [hashtable]$ModelsDevIndex
    )

    $id = Get-StringProperty -Object $CatalogItem -Name "model_name"
    if (-not $id) {
        return $null
    }

    $display = Get-StringProperty -Object $CatalogItem -Name "display_name"
    if (-not $display) {
        $display = $id
    }

    $hintText = @(
        (Get-StringProperty -Object $CatalogItem -Name "description"),
        (Get-StringProperty -Object $CatalogItem -Name "provider_name"),
        (Get-StringProperty -Object $CatalogItem -Name "provider_display")
    ) -join " "
    $providerHint = Get-OfficialProviderFromText -Text $hintText

    $resolved = Resolve-ModelsDevMeta -Index $ModelsDevIndex -ModelId $id -ProviderHint $providerHint
    $providerId = ""
    $meta = $null
    if ($resolved) {
        $providerId = Get-StringProperty -Object $resolved -Name "provider"
        $meta = Get-PropertyValue -Object $resolved -Name "meta"
    }
    if (-not $providerId) {
        $providerId = if ($providerHint) { $providerHint } else { Infer-OfficialProviderFromModelId -ModelId $id }
    }
    $entry = [ordered]@{
        id = $id
        name = $display
        options = @{}
    }

    if (-not $meta) {
        $meta = Get-FallbackMetaFromCatalog -ModelId $id -ProviderId $providerId -CatalogItem $CatalogItem
    }

    if (-not $meta) {
        throw "models.dev metadata was not found for model: $id"
    }

    # Keep model display name from co.yes.vg as source of truth for UI labels.
    # models.dev can be used for capabilities/limits/variants enrichment only.

    foreach ($stringField in @("family", "release_date")) {
        $value = Get-StringProperty -Object $meta -Name $stringField
        if ($value) {
            $entry[$stringField] = $value
        }
    }

    foreach ($boolField in @("attachment", "reasoning", "temperature", "tool_call", "experimental")) {
        $value = Get-NullableBooleanProperty -Object $meta -Name $boolField
        if ($null -ne $value) {
            $entry[$boolField] = $value
        }
    }

    $status = Get-StringProperty -Object $meta -Name "status"
    if ($status) {
        $normalizedStatus = $status.ToLowerInvariant()
        if (@("alpha", "beta", "deprecated") -contains $normalizedStatus) {
            $entry.status = $normalizedStatus
        }
    }

    $interleaved = Get-PropertyValue -Object $meta -Name "interleaved"
    if ($interleaved -is [bool]) {
        if ($interleaved) {
            $entry.interleaved = $true
        }
    } elseif ($interleaved) {
        $field = Get-StringProperty -Object $interleaved -Name "field"
        if (@("reasoning_content", "reasoning_details") -contains $field) {
            $entry.interleaved = [ordered]@{
                field = $field
            }
        }
    }

    $cost = Get-PropertyValue -Object $meta -Name "cost"
    if ($cost) {
        $input = Get-NullableNumberProperty -Object $cost -Name "input"
        $output = Get-NullableNumberProperty -Object $cost -Name "output"
        if ($null -ne $input -and $null -ne $output) {
            $costBlock = [ordered]@{
                input = $input
                output = $output
            }

            foreach ($optionalCost in @("cache_read", "cache_write")) {
                $optionalValue = Get-NullableNumberProperty -Object $cost -Name $optionalCost
                if ($null -ne $optionalValue) {
                    $costBlock[$optionalCost] = $optionalValue
                }
            }

            $contextOver200k = Get-PropertyValue -Object $cost -Name "context_over_200k"
            if ($contextOver200k) {
                $ctxInput = Get-NullableNumberProperty -Object $contextOver200k -Name "input"
                $ctxOutput = Get-NullableNumberProperty -Object $contextOver200k -Name "output"
                if ($null -ne $ctxInput -and $null -ne $ctxOutput) {
                    $ctxBlock = [ordered]@{
                        input = $ctxInput
                        output = $ctxOutput
                    }

                    foreach ($optionalCtx in @("cache_read", "cache_write")) {
                        $optionalCtxValue = Get-NullableNumberProperty -Object $contextOver200k -Name $optionalCtx
                        if ($null -ne $optionalCtxValue) {
                            $ctxBlock[$optionalCtx] = $optionalCtxValue
                        }
                    }

                    $costBlock.context_over_200k = $ctxBlock
                }
            }

            $entry.cost = $costBlock
        }
    }

    $limit = Get-PropertyValue -Object $meta -Name "limit"
    if ($limit) {
        $context = Get-NullableNumberProperty -Object $limit -Name "context"
        $output = Get-NullableNumberProperty -Object $limit -Name "output"
        if ($null -ne $context -and $null -ne $output) {
            $limitBlock = [ordered]@{
                context = [int64][math]::Floor($context)
            }

            $input = Get-NullableNumberProperty -Object $limit -Name "input"
            if ($null -ne $input) {
                $limitBlock.input = [int64][math]::Floor($input)
            }

            $limitBlock.output = [int64][math]::Floor($output)
            $entry.limit = $limitBlock
        }
    }

    $modalities = Get-PropertyValue -Object $meta -Name "modalities"
    if ($modalities) {
        $inputModalities = @(Normalize-Modalities -Value (Get-PropertyValue -Object $modalities -Name "input"))
        $outputModalities = @(Normalize-Modalities -Value (Get-PropertyValue -Object $modalities -Name "output"))

        if ($inputModalities.Count -gt 0 -and $outputModalities.Count -gt 0) {
            $entry.modalities = [ordered]@{
                input = $inputModalities
                output = $outputModalities
            }
        }
    }

    $reasoningSupported = $false
    if ($entry.Contains("reasoning") -and $entry.reasoning -is [bool]) {
        $reasoningSupported = [bool]$entry.reasoning
    }

    $releaseDate = ""
    if ($entry.Contains("release_date")) {
        $releaseDate = [string]$entry.release_date
    }

    $variants = Get-VariantsForModel -ProviderId $providerId -ModelId $id -ReleaseDate $releaseDate -ReasoningSupported $reasoningSupported
    $variants = Apply-OpenCodeDefaultVariantDisables -Variants $variants -ReasoningSupported $reasoningSupported
    if ($variants -and $variants.Count -gt 0) {
        $entry.variants = $variants
    }

    return $entry
}

function Get-YescodeModels {
    param([string]$ApiKey)

    if (-not $ApiKey) {
        throw "Missing yescode API key in opencode auth storage."
    }

    $modelsDev = Get-ModelsDevIndex
    $map = @{}
    $catalog = Invoke-JsonGetStrict -Uri "https://co.yes.vg/api/v1/public/models" -Headers @{
        Authorization = "Bearer $ApiKey"
        "x-api-key" = $ApiKey
    }

    if (-not $catalog -or -not $catalog.models) {
        throw "co.yes.vg /api/v1/public/models returned empty payload."
    }

    $matched = 0
    $excludedModelIds = @(
        "gemini-3.1-flash-image"
    )
    $excludedModelSet = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($excluded in $excludedModelIds) {
        if ($excluded) {
            [void]$excludedModelSet.Add($excluded)
        }
    }

    foreach ($item in $catalog.models) {
        $catalogModelId = Get-StringProperty -Object $item -Name "model_name"
        if ($catalogModelId -and $excludedModelSet.Contains($catalogModelId.Trim())) {
            continue
        }

        $entry = New-EnrichedModelFromCatalog -CatalogItem $item -ModelsDevIndex $modelsDev
        if (-not $entry) {
            continue
        }

        $id = [string]$entry.id
        if (-not $id -or -not $id.Trim()) {
            continue
        }

        $mapKey = $id.Trim().ToLowerInvariant()
        if (-not $map.ContainsKey($mapKey)) {
            $map[$mapKey] = $entry
            if ($entry.Contains("family") -or $entry.Contains("limit") -or $entry.Contains("modalities")) {
                $matched += 1
            }
        }
    }

    $result = @($map.GetEnumerator() | ForEach-Object { $_.Value } | Sort-Object { [string]$_.id })
    if ($result.Count -eq 0) {
        throw "Resolved zero models from co.yes.vg."
    }

    return [ordered]@{
        models = $result
        matched = $matched
    }
}

function Escape-JsonString {
    param([string]$Value)

    return $Value.Replace('\\', '\\\\').Replace('"', '\\"')
}

function Build-ModelsBlock {
    param([object[]]$Models)

    $entries = New-Object System.Collections.Generic.List[string]
    foreach ($model in $Models) {
        $id = [string]$model.id
        if (-not $id -or -not $id.Trim()) {
            continue
        }
        $safeId = Escape-JsonString -Value $id.Trim()
        $json = $model | ConvertTo-Json -Depth 100 -Compress
        $entries.Add("        `"$safeId`": $json")
    }

    if ($entries.Count -eq 0) {
        throw "Model list for yescode is empty."
    }

    $joined = [string]::Join(",`r`n", $entries)
    return "`"models`": {`r`n$joined`r`n      }"
}

function Set-YescodeModels {
    param(
        [string]$ConfigPath,
        [object[]]$Models
    )

    if (-not (Test-Path $ConfigPath)) {
        throw "Config file not found: $ConfigPath"
    }

    $raw = Get-Content -Path $ConfigPath -Raw
    $yescodePattern = '"yescode"\s*:\s*\{(?:[^{}]|(?<o>\{)|(?<-o>\}))*\}(?(o)(?!))'
    $yescodeMatch = [regex]::Match($raw, $yescodePattern)
    if (-not $yescodeMatch.Success) {
        throw "provider.yescode block was not found in $ConfigPath"
    }

    $yescodeObject = $yescodeMatch.Value
    $modelsBlock = Build-ModelsBlock -Models $Models
    $modelsPattern = '"models"\s*:\s*\{(?:[^{}]|(?<m>\{)|(?<-m>\}))*\}(?(m)(?!))'

    if ([regex]::IsMatch($yescodeObject, $modelsPattern)) {
        $yescodeObject = [regex]::Replace($yescodeObject, $modelsPattern, $modelsBlock, 1)
    } else {
        $closingIndex = $yescodeObject.LastIndexOf("}")
        if ($closingIndex -lt 0) {
            throw "Invalid provider.yescode object in $ConfigPath"
        }

        $prefix = $yescodeObject.Substring(0, $closingIndex)
        $needsComma = $prefix.TrimEnd() -notmatch '\{\s*$'
        $separator = if ($needsComma) { ",`r`n      " } else { "`r`n      " }
        $yescodeObject = "$prefix$separator$modelsBlock`r`n    }"
    }

    $updated = $raw.Substring(0, $yescodeMatch.Index) + $yescodeObject + $raw.Substring($yescodeMatch.Index + $yescodeMatch.Length)
    Write-FileUtf8NoBom -Path $ConfigPath -Content $updated
}

function Sync-YescodeModels {
    param([string]$ConfigPath)

    $key = Wait-YescodeApiKeyFromAuth
    if (-not $key) {
        throw "YesCode API key was not found in auth.json. Expected path: $AuthFilePath"
    }

    $payload = Get-YescodeModels -ApiKey $key
    $models = @($payload.models)
    Set-YescodeModels -ConfigPath $ConfigPath -Models $models
    Write-Output "[OK] Synced YesCode models: $($models.Count) (models.dev enriched: $($payload.matched))"
}

$SourceDir = [System.IO.Path]::GetFullPath($SourceDir)
$PluginEntry = Join-Path $SourceDir "yescode.mjs"
$RouterEntry = Join-Path $SourceDir "router\src\server.js"
if (-not (Test-Path $PluginEntry)) {
    throw "Plugin entry not found in '$SourceDir'. Run 'npm run build:opencode-plugin' first."
}
if (-not (Test-Path $RouterEntry)) {
    throw "Router bundle not found in '$SourceDir'. Run 'npm run build:opencode-plugin' first."
}

Assert-RequiredCliTools
Stop-RunningYescodeRouters

$pluginSpecifier = To-FileUri -Path $PluginEntry

New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
$configPath = Get-ConfigPath -Dir $ConfigDir

if (-not (Test-Path $configPath)) {
    $initial = @(
        '{',
        '  "$schema": "https://opencode.ai/config.json",',
        '  "plugin": [',
        '    "__PLUGIN_SPECIFIER__"',
        '  ],',
        '  "provider": {',
        '    "yescode": {',
        '      "name": "YesCode",',
        '      "npm": "@ai-sdk/openai",',
        '      "options": {',
        '        "baseURL": "http://127.0.0.1:8787/v1"',
        '      }',
        '    }',
        '  }',
        '}'
    ) -join "`r`n"

    Write-FileUtf8NoBom -Path $configPath -Content ($initial.Replace("__PLUGIN_SPECIFIER__", $pluginSpecifier))
} else {
    $raw = Get-Content -Path $configPath -Raw
    $next = Add-YescodeProvider -Raw $raw
    $next = Add-PluginRegistration -Raw $next -PluginSpecifier $pluginSpecifier
    Write-FileUtf8NoBom -Path $configPath -Content $next
}

Write-Output "[OK] Using '$PluginName' from source path: $SourceDir"
Write-Output "[OK] Embedded router path: $(Join-Path $SourceDir 'router')"
Write-Output "[OK] Registered plugin entry: $pluginSpecifier"
Write-Output "[OK] Updated $configPath with provider.yescode and plugin entry"

$opencode = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $opencode) {
    throw "opencode CLI not found in PATH."
}

$existingKey = Get-YescodeApiKeyFromAuth
if ($existingKey) {
    Write-Output "[OK] Existing YesCode API key found in auth.json, skip login."
} else {
    Write-Output "[INFO] Running: opencode auth login --provider yescode"
    & opencode auth login --provider yescode
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        throw "Could not complete opencode auth login for yescode (exit code: $exitCode)."
    }
}

Sync-YescodeModels -ConfigPath $configPath
Write-Output "[OK] YesCode provider is fully configured."
