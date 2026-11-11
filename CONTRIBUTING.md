# Contributing

Thanks for helping. Bug reports with the dashboard's details (personal info removed) are as valuable as code.

## Run it locally

```bash
npm install
cp wrangler.toml.example wrangler.toml      # fill in a KV id (any 32 hex chars works locally) and a budget id
printf 'PLAID_CLIENT_ID=...\nPLAID_SECRET=...\nYNAB_TOKEN=...\nADMIN_TOKEN=dev\n' > .dev.vars
npx wrangler dev --test-scheduled
```

- Use Plaid's **Sandbox** (`PLAID_ENV = "sandbox"`, sandbox secret) and a **test YNAB budget**. Never develop
  against your real budget.
- `http://localhost:8787/dashboard` (admin token `dev`), `/setup` to link a sandbox bank (`user_good` /
  `pass_good`), and `curl "http://localhost:8787/__scheduled"` runs the cron once.

## Checks

```bash
npm run check      # type check + tests
```

The same runs on every pull request. Add a test with any change to matching, transfers or the engine's
decisions: those are where a mistake becomes a duplicate or a missing charge in someone's budget.

## Where things are

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) maps the modules; [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)
explains the sync. Rules the code must keep:

- **Never guess an identity.** Own rows by import id or saved link; content matching is a fallback and
  one-to-one.
- **Only edit or delete rows the worker created.** (The one exception: marking a matched row cleared when the
  bank posts it at the same amount.)
- **Plan first, then write create → update → delete**, under the lock.
- **Stay inside free limits** (YNAB 200 requests/hour, Cloudflare KV writes).
- **Nothing personal in the code**: per-person rules belong in settings (KV), not constants.

## Pull requests

Small and focused is easiest to review. Describe what changed for a user, and add a line to
`CHANGELOG.md` under *Unreleased*.
