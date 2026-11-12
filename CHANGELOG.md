# Changelog

Notable changes for people running the worker. Versions follow [semantic versioning](https://semver.org):
a new major version means you need to do something when you update.

## Unreleased

- Dashboard: **Pause all syncing** / **Resume syncing** work again (they sent the wrong request and showed "POST only"), and say what they did.
- Dashboard: the result of a button (or why it failed) stays in view while you scroll, instead of appearing at the top of the page; click it to put it away.
- Dashboard: edits to skip rules, payee aliases, transfer labels and account settings are no longer thrown away when you switch tabs; "Unsaved changes" shows until you save, and leaving the page asks first.
- Dashboard: an account that needs reconnecting has a **Reconnect** button on its row (the banner used to point to a "Settings > Reconnect" that didn't exist).
- Dashboard: **Undo…** lists the recent syncs to pick from instead of asking you to type a number.
- Dashboard: **Sync now** and **Re-scan** name the account they'll act on when one is picked in the toolbar.
- Setup: says new accounts are added with sync off (it used to say they'd sync on the next run), marks the bank that needs reconnecting, marks YNAB accounts another bank account already feeds and asks before feeding one twice, and keeps its messages in view.
- Dashboard: turning an account's sync on reminds you to set its YNAB balance to the bank's posted balance first, and asks on Save.
- Dashboard: saving two accounts that feed the same YNAB account asks first (it usually imports everything twice).
- Dashboard: Activity on a phone shows one card per event instead of a squeezed table.
- Dashboard: the KPI tiles and tabs explain themselves (hover text, and a line under the tabs), so the glossary isn't needed.
- Account names keep ordinary short words in normal case ("Car Loan", "Bank of the West"); acronyms like PNC, TD and USAA stay capitals.
- Browser tests for the dashboard and setup pages, desktop and phone (`npm run test:browser`), run in CI.

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
