# Production Security Verification

Repository changes cannot inspect or change the Cloudflare account, Worker secrets, account-level IAM, or the currently deployed Worker. Complete this checklist against the production account before merging/deploying this remediation.

## Worker configuration

- [ ] Confirm the production Worker is the intended Worker and uses the repository's current `main` entry point.
- [ ] Confirm the `SYNC_STATE` KV binding points to the production namespace.
- [ ] Confirm the `SYNC_LOCK` Durable Object binding points to `SyncLock`.
- [ ] Confirm the SQLite Durable Object migration for `SyncLock` has been applied to production. Do not remove or rename the existing class or migration tag.
- [ ] Confirm the production Worker has the expected cron trigger and no unintended preview/dev route is attached.
- [ ] Confirm production is configured for Plaid production, not sandbox.

## Secrets

In the Cloudflare dashboard or with `npx wrangler secret list`, confirm these are Worker secrets (not plaintext `[vars]`):

- `ADMIN_TOKEN`
- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `YNAB_TOKEN`

Check that no secret values appear in Worker variables, GitHub repository variables, deployment logs, or build artifacts. Rotate a secret if it has ever been committed or exposed in logs; deleting it from the current file is not sufficient.

## Access and deployment permissions

- [ ] Restrict Cloudflare account access to named operators who need it; require MFA.
- [ ] Use a dedicated deployment API token/identity rather than a personal global API key.
- [ ] Scope the deployment identity to the target account and only the Worker, KV, and Durable Object permissions needed to deploy this service.
- [ ] Restrict who can edit Worker secrets and production routes separately from ordinary repository read access.
- [ ] Require review for changes to `.github/workflows/`, `wrangler.toml.example`, authentication, and webhook verification.
- [ ] Confirm GitHub branch protection requires the Check and Secret scan workflows before merge.

## Post-deployment smoke checks

Run these in a maintenance window after deploying to a non-production environment first:

- [ ] Open `/dashboard` and `/setup`; verify styles and scripts load, Plaid Link opens, and the browser console has no CSP violations.
- [ ] Confirm login creates a Secure, HttpOnly, SameSite=Strict `__Host-ynab_admin` cookie.
- [ ] Confirm logout invalidates the server-side session; replaying the old cookie must return 401.
- [ ] Confirm an invalid webhook signature is rejected and an identical valid webhook delivery is acknowledged as a duplicate.
- [ ] Confirm scheduled/manual sync still works and account balances and transaction counts reconcile before enabling production traffic.

Do not paste secret values, raw cookies, or transaction payloads into tickets or logs. Record pass/fail, timestamp, Worker version, and non-sensitive error identifiers only.
