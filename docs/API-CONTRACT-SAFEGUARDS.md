# External API contract and financial-write safeguards

## Plaid

- Cursor pagination is treated as one batch. If Plaid returns `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, every page from that attempt is discarded and the batch restarts from the original cursor. The cursor is committed only after a complete batch.
- `/transactions/get` snapshots must have stable totals, valid pages, unique transaction IDs, and the expected account ID. An incomplete snapshot cannot authorize pending-row retirement or matching.
- Plaid POST endpoints are retried only when they are read operations with explicitly safe replay semantics. Mutating Plaid endpoints are not blindly retried.
- Retry-After values are honored. If the requested wait exceeds the bounded Worker retry window, the request is deferred rather than retried early.

## YNAB

- Every YNAB HTTP attempt reserves capacity from a strongly consistent rolling one-hour budget in the SyncLock Durable Object. The worker limit is 180 requests/hour against YNAB's documented 200/hour token limit, leaving headroom for other clients.
- YNAB POST/PATCH/DELETE operations are not blindly replayed after ambiguous failures. A batch PATCH falls back to row-by-row only after a definitive HTTP 400 validation rejection.
- A transfer create is read back from both accounts. The source and target must point to each other, identify the expected accounts, and contain opposite milliunit amounts before the cursor can advance.
- The destination plan's ISO currency is read from plan settings. New or amount-modified transactions are blocked when Plaid's transaction currency differs because this application does not perform FX conversion.
- Malformed 2xx response envelopes are treated as unknown outcomes, not as empty success.

## Account identity

- Ordinary account saves cannot change a mapped Plaid account ID or YNAB destination under the same nickname.
- A separate locked migration endpoint handles a Plaid account-ID change only after a new Item has been linked and the operator confirms the existing YNAB destination and same real-world bank account.
- The migration retains the old Plaid-ID state, requires the new ID to have no prior sync state, keeps the YNAB destination unchanged, and disables writes until a dry run has been reviewed.

## Date windows

Date-only Plaid windows and the identity horizon use the configured IANA timezone's calendar date, then shift dates using UTC-midnight date arithmetic. This avoids using the Worker's UTC day boundary as the bank's local calendar boundary.
