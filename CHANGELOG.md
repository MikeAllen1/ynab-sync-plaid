# Changelog

Notable changes for people running the worker. Versions follow [semantic versioning](https://semver.org):
a new major version means you need to do something when you update.

## Unreleased

## 1.0.0 — 2026-11-11

First public release.

- Plaid → YNAB sync: pending charges as uncleared rows, flipped in place when they post, posted charges once.
- Card payments and transfers between linked accounts as YNAB transfers; stable payee names for other transfers.
- Matches rows you entered by hand and YNAB Direct Import rows instead of duplicating them.
- Dashboard: account health (bank vs YNAB balance), activity, dry run, undo, pause.
- `/setup` to link and reconnect banks with Plaid Link.
- Skip rules, payee aliases, transfer labels.
- Verified Plaid webhooks; email (Resend) and webhook alerts.
- `PLAID_REFRESH = "off"` to avoid billed refresh calls on paid Plaid plans.
- Tests for matching, transfers, skip rules and the engine's decisions; CI on every pull request.
