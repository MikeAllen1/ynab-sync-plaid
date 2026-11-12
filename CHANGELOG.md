# Changelog

Notable changes for people running the worker. Versions follow [semantic versioning](https://semver.org):
a new major version means you need to do something when you update.

## Unreleased

Fixes from a workflow audit of the dashboard and setup page:

- **Pause all syncing works.** The button sent a GET and always failed with "POST only".
- **Deleting a skip rule, alias group or transfer label deletes only that one.** It used to also save every
  unsaved, half-typed edit on the page (and any unfinished new rule), and a double click on a transfer label's
  Remove deleted two labels.
- **A page that's out of date can't overwrite newer settings.** Saving accounts, rules, aliases or labels from a
  page loaded before a change made elsewhere is refused with an explanation, then reloaded. Before, it could drop
  a bank account just added on the setup page, or turn back on an account switched off on another device.
- **Unsaved edits aren't thrown away** when you switch tabs, and leaving the page with unsaved edits (or while a
  save is still being sent) asks first.
- **Incomplete entries aren't silently dropped.** Saving a rule without bank text (or an alias or label missing
  its fields) now says what's missing instead of reporting "saved" and discarding it.
- **Lost responses are reported honestly.** If the connection drops before the worker answers, the page says the
  change may have gone through instead of "Failed to fetch"; retrying "Add this account" after a lost response
  reports it added instead of "already exists".
- Sync now for one account reports only that account; Undo's preview says when rows it will delete were already
  approved in YNAB; the setup page no longer says new accounts start syncing (they're added with sync off);
  results for a previous account choice are cleared when you pick another.
- `npm run test:browser`: end-to-end browser tests for these workflows (needs Chrome).

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
