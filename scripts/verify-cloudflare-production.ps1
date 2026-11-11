$ErrorActionPreference = "Stop"

if (-not $env:CLOUDFLARE_API_TOKEN) {
    throw "Set CLOUDFLARE_API_TOKEN to a Cloudflare API token with Workers Scripts Read permission. Do not paste the token into chat or commit it."
}
if (-not $env:CLOUDFLARE_ACCOUNT_ID) {
    throw "Set CLOUDFLARE_ACCOUNT_ID to the Cloudflare account ID that owns the Worker."
}

$workerName = "ynab-sync"
$base = "https://api.cloudflare.com/client/v4/accounts/$($env:CLOUDFLARE_ACCOUNT_ID)/workers/scripts/$workerName"
$headers = @{ Authorization = "Bearer $($env:CLOUDFLARE_API_TOKEN)" }

Write-Host "Reading deployed Worker settings from Cloudflare..."
$settings = Invoke-RestMethod -Method Get -Uri "$base/settings" -Headers $headers
if (-not $settings.success) { throw "Cloudflare did not return Worker settings successfully." }

$binding = @($settings.result.bindings | Where-Object {
    $_.name -eq "SYNC_LOCK" -and
    $_.type -eq "durable_object_namespace" -and
    $_.class_name -eq "SyncLock" -and
    -not [string]::IsNullOrWhiteSpace($_.namespace_id)
}) | Select-Object -First 1

if (-not $binding) {
    Write-Error "FAIL: production Worker is missing the SYNC_LOCK Durable Object binding for class SyncLock. Financial writes will fail closed until deployed correctly."
    exit 1
}

Write-Host "PASS: production binding SYNC_LOCK points to SyncLock and has a namespace ID."
Write-Host "Reading deployed Worker migration metadata..."
$script = Invoke-RestMethod -Method Get -Uri $base -Headers $headers
if (-not $script.success) { throw "Cloudflare did not return Worker script metadata successfully." }

$migrationTag = $script.result.migration_tag
if ([string]::IsNullOrWhiteSpace($migrationTag)) {
    Write-Error "FAIL: Cloudflare returned no applied Durable Object migration tag. Confirm the SyncLock migration has been deployed."
    exit 1
}

Write-Host "PASS: Cloudflare reports applied Durable Object migration tag '$migrationTag'."
Write-Host "Production Durable Object binding and migration metadata are present."
