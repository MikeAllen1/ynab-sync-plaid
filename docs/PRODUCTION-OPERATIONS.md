# Production operations and recovery

This runbook defines the minimum operating procedure for the Worker. It does not claim that
Cloudflare production resources have been inspected, that backups are configured, or that a
restore has been tested. Those are explicit release gates.

## Release gates

Before deploying a release:

1. Review the release diff and its persisted-state compatibility notes.
2. Run `npm ci`, `npm run typecheck`, `npm test`, `npm audit --audit-level=high`,
   and the Wrangler dry-run used by CI.
3. Deploy to a non-production Worker with isolated KV and Durable Object namespaces.
4. Run the production verification script against that environment. Supply
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `EXPECTED_SYNC_STATE_KV_NAMESPACE_ID`, `WORKER_BASE_URL`, and
   `ADMIN_TOKEN` through the local process environment or a protected CI environment.
   The Cloudflare token must be read-only for Worker scripts/settings/schedules.
5. Confirm the authenticated `/health` result is `healthy`, global sync is enabled,
   the Durable Object lock is active, and no account is overdue.
6. Perform a controlled end-to-end sync using non-sensitive test data. Confirm the
   resulting YNAB-side transactions and the next cursor/checkpoint before promoting.
7. Record the deployed Worker version, migration tag, KV namespace ID, cron schedule,
   and release commit in the change record.

Do not deploy a release that changes the meaning or shape of persisted state unless the
release documents forward compatibility, rollback compatibility, and a tested recovery
path. A Worker code rollback does not roll back KV or Durable Object data.

## Post-deployment verification

Run `scripts/verify-cloudflare-production.ps1` from a trusted workstation or protected
deployment runner. It checks:

- the expected `SYNC_STATE` KV namespace binding;
- the `SYNC_LOCK` Durable Object binding;
- presence (not values) of required secret bindings;
- Cloudflare's applied Durable Object migration tag;
- the 15-minute cron schedule; and
- optionally, the authenticated application health report.

The script intentionally does not retrieve, print, or validate secret values. A successful
secret-binding check proves only that the binding exists, not that the credential is valid.
Credential validity is established only by successful authenticated provider operations.

## Monitoring requirements

The repository includes `.github/workflows/production-health.yml`, an **opt-in** check that runs
every 15 minutes and on manual dispatch. It is skipped until you set the repository Actions
variable `ENABLE_PRODUCTION_HEALTH_CHECK` to `true` and add the Actions secrets
`WORKER_BASE_URL` (HTTPS Worker origin) and `HEALTH_TOKEN`.

`HEALTH_TOKEN` is a separate, read-only credential. Create it with
`npx wrangler secret put HEALTH_TOKEN` (a long random value, different from `ADMIN_TOKEN`)
and add the same value as the Actions secret. It can only read a minimal `/health` summary
(status, pause state, lock mode, overdue account names): no balances, no transactions, and
no way to change anything. Never give the monitor `ADMIN_TOKEN`; if an older setup did, delete
that Actions secret once `HEALTH_TOKEN` works. (Without `HEALTH_TOKEN` the probe still falls
back to `ADMIN_TOKEN` and warns.)

The probe calls `/health` and fails without printing the payload if the service is unhealthy,
paused, missing the Durable Object lock, or has overdue accounts. A failed run is visible in GitHub Actions; configure GitHub notification
subscriptions or a separate alert destination if operators need delivery outside GitHub.
GitHub scheduled jobs can be delayed, so this is a useful independent check, not a strict
15-minute paging SLA.

Monitor the application from outside the Worker. At minimum, evaluate the authenticated
`/health` report and alert when:

- `health_status` is not `healthy`;
- global synchronization is paused unexpectedly;
- `lock_mode` is not `durable-object`;
- any enabled account is overdue or not bootstrapped;
- `last_success_age_minutes` exceeds the operating objective;
- `last_partial`, `last_error`, or `last_alert_failure` is present; or
- the endpoint cannot be reached or authenticated.

The Worker cannot reliably alert about its own total outage. The external monitor must have
an independent notification destination and must alert when its health probe fails. Do not
use Worker HTTP liveness alone as proof of financial synchronization.

## Backup and restore gate

The repository does not provide a complete, automated, transactionally consistent export
and restore of KV plus Durable Object state. Do not represent a Cloudflare KV export alone
as a complete application backup.

Before unattended production operation, implement and test an encrypted backup that
captures the complete logical state, including account configuration, automation settings,
Plaid cursors, bootstrap markers, transaction ownership links, import/create recovery
intents, card epochs, and any other state required to resume safely. Keep backups outside
the production Cloudflare account and restrict access.

A restore test must use an isolated environment and demonstrate that:

1. the restored account-to-YNAB mappings are unchanged;
2. cursors and transaction ownership links agree;
3. previously imported transactions are not duplicated;
4. incomplete creates/updates/deletes are reconciled safely;
5. the application can resume from the restored checkpoint; and
6. the restored state is not allowed to write to real financial accounts until reviewed.

If a complete consistent backup or restore has not been tested, mark disaster recovery
as **not verified**. Do not improvise a partial restore into production.

## Incident response

### Plaid or YNAB outage

- Leave cursors unchanged for incomplete pages or unresolved financial writes.
- Allow scheduled retries only where the request is safe to retry.
- Check the oldest outstanding/partial account operation.
- After provider recovery, run one account at a time and reconcile the YNAB register
  against the bank before restoring normal scheduling.

### KV or Durable Object failure

- Fail closed: do not bypass the Durable Object writer lock or seed production state
  from stale environment variables.
- Preserve Cloudflare logs and the last known release/configuration fingerprint.
- Restore service availability first; do not reset cursors or recreate state to make
  the dashboard appear healthy.
- Reconcile outstanding remote writes before resuming automatic sync.

### Bad deployment

- Stop further deployments and pause financial writes if the running release may
  misinterpret persisted state.
- Roll back code only to a version documented as compatible with the current persisted
  schema. Do not assume a code rollback reverses data writes or Durable Object migrations.
- Verify bindings, migration state, and account freshness after rollback.
- Reconcile transactions before unpausing.

## Recovery acceptance criteria

An incident is not resolved merely because the Worker returns HTTP 200 or the dashboard
shows healthy. Close the incident only after every enabled account is current, there are
no unresolved partial/error operations, Plaid cursors are consistent with processed
transactions, and the YNAB register has been reconciled for the affected period.
