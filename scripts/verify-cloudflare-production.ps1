$ErrorActionPreference = "Stop"

# This script verifies deployed infrastructure and, optionally, the authenticated
# application health report. It never reads or prints secret values.
$required = @("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "EXPECTED_SYNC_STATE_KV_NAMESPACE_ID")
foreach ($name in $required) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
        throw "Set $name in the environment. Never paste credentials into chat or commit them."
    }
}

$workerName = if ($env:CLOUDFLARE_WORKER_NAME) { $env:CLOUDFLARE_WORKER_NAME } else { "ynab-sync" }
$base = "https://api.cloudflare.com/client/v4/accounts/$($env:CLOUDFLARE_ACCOUNT_ID)/workers/scripts/$workerName"
$headers = @{ Authorization = "Bearer $($env:CLOUDFLARE_API_TOKEN)" }

function Invoke-CloudflareGet([string]$Uri) {
    $response = Invoke-RestMethod -Method Get -Uri $Uri -Headers $headers
    if (-not $response.success) { throw "Cloudflare API request failed: $Uri" }
    return $response.result
}

Write-Host "Checking deployed Worker settings..."
$settings = Invoke-CloudflareGet "$base/settings"
$bindings = @($settings.bindings)

$kv = @($bindings | Where-Object {
    $_.name -eq "SYNC_STATE" -and $_.type -eq "kv_namespace"
}) | Select-Object -First 1
if (-not $kv) { throw "FAIL: SYNC_STATE KV binding is missing." }
if ($kv.namespace_id -ne $env:EXPECTED_SYNC_STATE_KV_NAMESPACE_ID) {
    throw "FAIL: SYNC_STATE points to an unexpected KV namespace. Expected and deployed IDs differ."
}
Write-Host "PASS: SYNC_STATE points to the expected KV namespace."

$lock = @($bindings | Where-Object {
    $_.name -eq "SYNC_LOCK" -and $_.type -eq "durable_object_namespace" -and
    $_.class_name -eq "SyncLock" -and -not [string]::IsNullOrWhiteSpace($_.namespace_id)
}) | Select-Object -First 1
if (-not $lock) { throw "FAIL: SYNC_LOCK Durable Object binding for SyncLock is missing." }
Write-Host "PASS: SYNC_LOCK Durable Object binding is present."

$requiredSecrets = @("PLAID_CLIENT_ID", "PLAID_SECRET", "YNAB_TOKEN", "ADMIN_TOKEN")
$secretBindings = @($bindings | Where-Object { $_.type -eq "secret_text" } | ForEach-Object { $_.name })
foreach ($secretName in $requiredSecrets) {
    if ($secretBindings -notcontains $secretName) {
        throw "FAIL: required secret binding '$secretName' is not present. Secret values are never retrieved."
    }
}
Write-Host "PASS: required secret bindings are present (values not inspected)."

Write-Host "Checking deployed Durable Object migration metadata..."
$scriptInfo = Invoke-CloudflareGet $base
if ([string]::IsNullOrWhiteSpace($scriptInfo.migration_tag)) {
    throw "FAIL: Cloudflare reports no applied Durable Object migration tag."
}
Write-Host "PASS: Cloudflare reports migration tag '$($scriptInfo.migration_tag)'."

Write-Host "Checking deployed cron schedules..."
$schedules = Invoke-CloudflareGet "$base/schedules"
$crons = @($schedules | ForEach-Object { $_.cron })
if ($crons -notcontains "*/15 * * * *") {
    throw "FAIL: expected 15-minute cron schedule is not deployed."
}
Write-Host "PASS: expected 15-minute cron schedule is deployed."

# Optional end-to-end application check. ADMIN_TOKEN is exchanged for the same
# HttpOnly session cookie used by the dashboard; the health payload is not printed.
if ($env:WORKER_BASE_URL) {
    if ([string]::IsNullOrWhiteSpace($env:ADMIN_TOKEN)) {
        throw "Set ADMIN_TOKEN when WORKER_BASE_URL is supplied."
    }
    $workerBase = $env:WORKER_BASE_URL.TrimEnd("/")
    $session = Invoke-WebRequest -Method Post -Uri "$workerBase/session" -Headers @{
        Origin = $workerBase
        "x-admin-token" = $env:ADMIN_TOKEN
    } -SessionVariable workerSession
    if ($session.StatusCode -ne 200) { throw "FAIL: application admin session could not be established." }

    $healthResponse = Invoke-RestMethod -Method Get -Uri "$workerBase/health" -WebSession $workerSession
    if (-not $healthResponse.ok) { throw "FAIL: application health endpoint returned ok=false." }
    if ($healthResponse.health_status -ne "healthy") {
        throw "FAIL: application health_status is '$($healthResponse.health_status)', not 'healthy'. Review the authenticated /health report."
    }
    if (-not $healthResponse.sync_enabled) { throw "FAIL: global synchronization is paused." }
    if ($healthResponse.lock_mode -ne "durable-object") { throw "FAIL: application is not using the Durable Object lock." }
    if (@($healthResponse.overdue_accounts).Count -gt 0) {
        throw "FAIL: one or more accounts are overdue: $(@($healthResponse.overdue_accounts) -join ', ')."
    }
    Write-Host "PASS: authenticated application health is healthy and no accounts are overdue."
} else {
    Write-Warning "WORKER_BASE_URL was not supplied; application-level health was not checked."
}

Write-Host "Production infrastructure verification passed."
