# Setup guide

Follow these pages in order. Plan on about an hour the first time, most of it waiting on Plaid.

1. [Plaid](1-plaid.md): an account, your keys, and the redirect address for banks like Chase
2. [YNAB](2-ynab.md): a personal access token and your budget id
3. [Cloudflare](3-cloudflare.md): a free account and the command-line tool
4. [The worker](4-worker.md): configure, deploy, link your banks, start syncing
5. [Everyday use and troubleshooting](5-everyday-use.md)

## Checklist

Keep these somewhere safe as you go (a password manager is ideal). None of them go in the repo.

| From | Value | Used as |
|---|---|---|
| Plaid | client_id | secret `PLAID_CLIENT_ID` |
| Plaid | Production secret (or Sandbox secret to test) | secret `PLAID_SECRET` |
| YNAB | Personal access token | secret `YNAB_TOKEN` |
| YNAB | Budget id | `YNAB_BUDGET_ID` in `wrangler.toml` |
| You | A long random password | secret `ADMIN_TOKEN` (the dashboard asks for it) |
| Cloudflare | KV namespace id | `id` in `wrangler.toml` |

## Will I end up with the same setup as the author?

The same sync, yes: the code is identical. What's different is what's personal:

- **Your own Plaid account.** Plaid decides your plan and limits (see [Plaid](1-plaid.md)).
- **Your own rules.** The author's skip rules, payee aliases, card-payment rules and transfer labels are
  not included. You add your own on the dashboard once you see how your banks word things.
- **Your own Cloudflare address**, e.g. `https://ynab-sync.<you>.workers.dev`.
