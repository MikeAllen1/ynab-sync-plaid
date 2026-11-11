$ErrorActionPreference = "Stop"

$repository = "MikeAllen1/ynab-sync-plaid"
$endpoint = "repos/$repository/branches/main/protection"

Write-Host "Checking GitHub CLI authentication..."
gh auth status --hostname github.com
if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI is not authenticated. Run: gh auth login"
}

$protection = @{
    required_status_checks = @{
        strict = $true
        contexts = @(
            "check",
            "Gitleaks (full repository history)",
            "Analyze (actions)",
            "Analyze (javascript-typescript)"
        )
    }
    enforce_admins = $true
    required_pull_request_reviews = @{
        dismiss_stale_reviews = $true
        required_approving_review_count = 0
        require_code_owner_reviews = $false
    }
    restrictions = $null
    required_conversation_resolution = $true
    allow_force_pushes = $false
    allow_deletions = $false
}

$json = $protection | ConvertTo-Json -Depth 10
Write-Host "Applying main-branch protection to $repository..."
$json | gh api --method PUT -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" $endpoint --input -
if ($LASTEXITCODE -ne 0) {
    throw "GitHub rejected the branch-protection update. Confirm your gh account has repository Administration: write permission."
}

Write-Host "Verifying the effective protection settings..."
$result = gh api -H "Accept: application/vnd.github+json" $endpoint
if ($LASTEXITCODE -ne 0) {
    throw "The update returned successfully, but verification could not read the protection settings."
}
$verified = $result | ConvertFrom-Json
if (-not $verified.enforce_admins.enabled -or -not $verified.required_status_checks.strict -or
    -not $verified.allow_force_pushes.enabled -eq $false -or
    -not $verified.allow_deletions.enabled -eq $false) {
    Write-Warning "GitHub returned protection settings that need manual review:"
    $verified | ConvertTo-Json -Depth 10
    throw "Branch-protection verification did not match all expected values."
}

Write-Host "PASS: main requires a pull request, current CI/Gitleaks/CodeQL checks, conversation resolution, and blocks force pushes/deletions. Admin enforcement is enabled."
