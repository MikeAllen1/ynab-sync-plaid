# 2. YNAB

## Personal access token

1. Sign in at <https://app.ynab.com>.
2. Open **Account Settings → Developer Settings**.
3. Under **Personal Access Tokens**, click **New Token**, enter your password, and copy the token.
   YNAB shows it once. It becomes the `YNAB_TOKEN` secret.

The token can read and change your whole YNAB account, so treat it like a password. If it ever leaks, delete it
on the same page and make a new one.

## Budget id

Open the budget you want to sync. The address looks like:

```
https://app.ynab.com/1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d/budget
```

The long id in the middle is your budget id. It becomes `YNAB_BUDGET_ID` in `wrangler.toml`.

## Accounts in YNAB

Each bank account you sync needs a matching account in YNAB (checking for checking, credit card for a credit
card). Create any that are missing now. You'll pick which YNAB account each bank account feeds in
[step 4](4-worker.md).

**If YNAB's own bank import (Direct Import) is already linked to an account**, decide which one feeds it. The
worker can live alongside Direct Import (it matches rows Direct Import created instead of duplicating them),
but one feed per account is simpler: unlink Direct Import in YNAB (account → Edit → Unlink) before turning the
worker on for that account.
