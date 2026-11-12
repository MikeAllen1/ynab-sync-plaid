# Security

## What this worker holds

- **Plaid access tokens** for your banks, stored in your Cloudflare KV, encrypted with AES-256-GCM when the
  `TOKEN_ENCRYPTION_KEY` secret is set (recommended; `/health` reports `token_storage`).
- Your **YNAB token**, **Plaid secret** and **admin token**, stored as encrypted Cloudflare secrets.
- Sync state and logs (amounts, dates, payee names) in the same KV namespace.

Nothing is sent anywhere except Plaid, YNAB, and (only if you set it up) your alert email/webhook.

## How it's protected

- Every endpoint that reads or changes data requires the `x-admin-token` header, compared in constant time.
  Pages ask for the token in the browser and keep it in that browser's local storage.
- Plaid webhooks are verified (signed JWT, body hash, key fetched from Plaid).
- The dashboard and setup pages send `X-Frame-Options: DENY` and a `frame-ancestors 'none'` policy.
- Writes run under a single lock, so concurrent requests can't race.

## Keeping your copy safe

- Use a long random `ADMIN_TOKEN` and don't reuse it anywhere. Rotate it with
  `npx wrangler secret put ADMIN_TOKEN` if it might have leaked.
- Never commit `wrangler.toml`, `.dev.vars` or anything with a token in it (`.gitignore` covers the usual files).
- Never paste tokens, account numbers or real names in a GitHub issue.
- If a YNAB token leaks: delete it in YNAB → Developer Settings and make a new one. If Plaid keys leak: rotate the
  secret in the Plaid dashboard.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting:
[Report a vulnerability](https://github.com/MikeAllen1/ynab-sync-plaid/security/advisories/new).
Include what you found and how to reproduce it. This is a personal project, so responses are best effort, but
security reports come first.
