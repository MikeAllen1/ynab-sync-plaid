# How the code is organized

One Cloudflare Worker, split into small modules. `src/index.ts` is the entry point; everything else is
plain functions grouped by job.

```
src/
  index.ts                 HTTP routes, the cron (scheduled), Durable Object export
  types.ts                 Env (bindings, vars, secrets) and shared types
  constants.ts             Windows, limits and defaults (all in one place)

  sync/
    run.ts                 syncAll: which accounts are due, locking, alerts after a run
    engine.ts              The sync engine: one identity per charge, pending -> posted in place,
                           desired rows vs YNAB, bootstrap
    matching.ts            Import ids and content matching (amount + payee + date, one-to-one)
    transfers.ts           Card payments, transfers between your own accounts, stable payee names
    undo.ts                Undo a sync

  plaid/
    client.ts              plaidCall (one place that talks to Plaid)
    fetch.ts               Reading transaction windows (cached per run) + debug views
    webhooks.ts            Verified webhooks, refresh requests, webhook setup

  ynab/
    client.ts              Every YNAB API call (create/update/delete, accounts, history)

  audit/
    audit.ts               Read-only account health: bank balance vs YNAB, pending coverage
    reconcile.ts           Transaction-level bank vs YNAB comparison

  health/
    items.ts               Bank connection health (needs reauth, stale data), alert emails,
                           stuck pending explanations
    status.ts              /health and the dashboard's status summary

  store/
    accounts.ts            Linked accounts and per-account settings (KV)
    event-log.ts           What each sync did (KV, last 200 events)
    card-epoch.ts          Re-adding a card's history after deleting it in YNAB
    durable-state.ts       Per-account sync state (cursor, links, posted ids...) kept in the
                           SyncLock Durable Object, next to the lock that guards it

  rules/
    skip-rules.ts          Bank items never to import
    payee-aliases.ts       Names that mean the same merchant
    transfer-labels.ts     Your own accounts elsewhere, named by their last digits

  lock/
    sync-lock-do.ts        The SyncLock Durable Object (one writer at a time)
    lock.ts                Acquire / renew / release (Durable Object only; no KV fallback: writes stop
                           if the lock can't be reached)

  ui/
    dashboard-page.ts      /dashboard (HTML + its small script)
    setup-page.ts          /setup: link or reconnect banks with Plaid Link

  util/
    http.ts                fetch with retries, JSON responses, admin-token check
    dates.ts               Calendar-day math in your time zone
    errors.ts              Plain-English error messages
```

## Where things are stored

Everything lives in the `SYNC_STATE` KV namespace in your Cloudflare account: linked accounts and their
Plaid tokens (`account_map`), per-account settings, sync cursors, the link between each Plaid charge and
its YNAB row, rules, logs and undo batches. Nothing is stored anywhere else.

## Ground rules the code keeps

- **Never guess an identity.** A charge's YNAB row is found by import id or a saved link first; content
  matching only applies to rows the worker didn't create.
- **One writer at a time.** Every sync, undo or bootstrap runs under the `SyncLock` Durable Object.
- **Retire pending rows only when the bank says so**, never on age alone.
- **Stay inside the free limits**: YNAB is read in a ~5-week window, Plaid items are read once per run.
