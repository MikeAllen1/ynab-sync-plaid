# Plaid account-ID migration

Use this only when Plaid has issued a different `account_id` for the **same real-world bank account** and a normal update-mode reconnect did not preserve the ID.

This is not a way to move a feed to a different YNAB account. The migration keeps the existing YNAB destination, retains the old Plaid-ID state in KV, gives the new Plaid ID a fresh cursor, and pauses writes until a dry run is reviewed.

## Procedure

1. Pause global syncing in the dashboard.
2. Open `/setup` and link the affected bank again. This creates a server-side pending link and exposes the new Item's account choices.
3. Verify the selected bank account using the institution, account name, and full account details available from the bank. Do not rely on last four digits alone.
4. Call the authenticated `POST /accounts/migrate-plaid-id` endpoint with:
   ```json
   {
     "nickname": "checking",
     "link_id": "<pending link id>",
     "plaid_account_id": "<new Plaid account id>",
     "confirm_same_account": true,
     "confirm_ynab_account_id": "<the existing YNAB account id>"
   }
   ```
5. The endpoint verifies that the new Plaid account belongs to the pending Item and that the existing YNAB account is still active. It executes under the global writer lock, disables global sync and the affected account before changing identity, refuses a new Plaid ID with existing sync state, records a migration receipt, retains all old-ID state, and changes the mapping.
6. Run a dry run. Inspect the proposed creates, matches, transfers, and balances against the existing YNAB register. The new Plaid cursor bootstraps independently; historical rows should match the existing register rather than be imported again.
7. Wait at least 60 seconds for KV propagation, then re-enable the affected account and global sync only after the dry run and reconciliation are correct.

## Safety boundaries

- Ordinary account saves reject Plaid or YNAB ID changes under an existing nickname. Token rotation remains allowed when IDs are unchanged.
- The migration endpoint requires explicit confirmation and cannot change the YNAB destination.
- Old cursor, posted-ID, pending, link, and diagnostic state remains under the old Plaid account ID; it is not copied onto the new identity.
- If the new ID already has sync state, migration stops without changing the account map.
- If the migration fails after the account has been paused, leave it paused and inspect the `account_migration:<migration_id>` KV receipt before retrying.
- This operation does not merge two different real-world accounts and does not perform foreign-exchange conversion.
