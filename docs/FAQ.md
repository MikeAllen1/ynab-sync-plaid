# FAQ

### What does it cost?

Nothing on the Cloudflare side: the free Workers plan covers it. Plaid's free **Trial plan** (US/Canada, personal
use) allows up to 10 bank logins. Paid Plaid plans charge per bank login per month for Transactions, and per call
for refresh requests (set `PLAID_REFRESH = "off"` to avoid those). YNAB is your normal subscription.

### Can it mess up my existing YNAB history?

It only adds rows for new bank activity, and it only **edits or deletes rows it created itself**. A row you
typed in, or one Direct Import added, is matched and linked, never deleted. The one change it makes to such a
row is marking it **cleared** once the bank posts that charge at the same amount, as Direct Import would;
payee, category, memo, amount and date stay as you entered them. Reconciled rows are never touched. It doesn't touch anything
older than its import window (7 days by default; the first sync starts from today's pending charges). The rows any
sync added can be removed again from the dashboard (*Undo…*; it doesn't reverse flips, removals or updates), and **Dry run** shows what a sync would do before it does it.

### Do I need to turn off YNAB's Direct Import?

No, but one feed per account is simpler. The worker recognizes rows Direct Import created and won't duplicate
them (posted rows even use YNAB's own import id format, so YNAB itself dedupes). The worker's advantage is
pending charges; Direct Import only shows posted ones. See [YNAB setup](setup/2-ynab.md).

### Is my bank data safe?

- Your bank login goes to Plaid, never to the worker.
- Plaid gives the worker an access token, stored in **your** Cloudflare KV. It isn't in the code, the repo or
  anywhere else.
- Every page and endpoint that reads or changes data needs your admin token. Plaid webhooks are verified with
  Plaid's signatures.
- Nobody else runs a server for this: it's your Cloudflare account, your Plaid account, your YNAB token.

See [SECURITY.md](../SECURITY.md) for details and how to report a problem.

### A charge is missing / doubled / has the wrong name

See the table in [Everyday use and troubleshooting](setup/5-everyday-use.md#something-looks-wrong).

### Why does a charge show up pending and then change amount?

Restaurants (tips), gas stations and hotels pre-authorize one amount and settle another. The worker updates the
same row to the final amount when it posts.

### Why didn't my card payment become a transfer?

The worker needs to know which card the payment is for. Set the card's **Payments name it by last 4 / words**
in dashboard → Settings to how your checking statement words it (for example `1234` or `sapphire`).

### What happens when the Plaid Trial's 10 bank logins run out?

Plaid won't let you link an 11th. Remove a bank you no longer need in Plaid, or move to a paid Plaid plan. The
worker doesn't need any change either way.

### Does it work outside the US and Canada?

The worker itself doesn't care, but Plaid's free plan is US/Canada only and its coverage elsewhere varies.

### Can I sync more than one budget?

One worker syncs one budget. Deploy a second copy (different `name` in `wrangler.toml` and its own KV namespace)
for another budget.

### Can I use it with investment or loan accounts?

Not for their balances. See [Known limitations](LIMITATIONS.md).

### How do I update it?

`git pull`, `npm install`, `npx wrangler deploy`. Your settings and banks live in Cloudflare, so they're kept.
What changed is in the [changelog](../CHANGELOG.md).

### How do I stop it?

Pause on the dashboard (Settings → Global sync), or delete the worker in Cloudflare. To revoke Plaid's access
too, remove the connection in your bank's "connected apps" page.

### Is this affiliated with YNAB or Plaid?

No. It's an independent project that uses their public APIs.
