# Known limitations

Things it doesn't do, or does only partly. If one of these matters to you, an issue is welcome.

- **US and Canada only on Plaid's free Trial plan**, with up to 10 bank logins. Other countries and more banks
  need a paid Plaid plan (and Plaid's coverage there).
- **Bank and credit card accounts only.** Investment, loan and mortgage balances aren't synced. Payments *to*
  them from checking come through as ordinary outflows.
- **One YNAB budget per worker.** For a second budget, deploy a second copy with its own KV namespace.
- **The bank feed lags the bank.** Plaid usually trails your bank's own app by a few hours, sometimes a day.
  Pending charges some banks never send to Plaid won't show until they post.
- **No splits.** The worker imports one row per charge and never creates split transactions. Split a row yourself
  in YNAB after it posts.
- **Categories are yours too.** Rows arrive uncategorized and unapproved. YNAB's own payee rules categorize
  repeat merchants after you've done it once.
- **YNAB allows 200 API requests per hour per token.** The worker stays well under that by reading a ~5-week
  window, but running *Re-scan* over long windows on many accounts in a short time can hit it. It recovers by
  itself within the hour.
- **Charges older than ~120 days** aren't created, even if the bank replays them after a long outage, because
  they can't be checked against YNAB for a duplicate. They're listed on the dashboard for you to review.
- **One currency.** There's no currency conversion. A charge whose currency differs from your YNAB budget's
  currency stops that account's sync with a "Currency mismatch" error rather than importing a wrong amount.
  A bank row with no standard currency code (some Plaid rows only carry an unofficial code, such as crypto) or
  with more decimal places than YNAB stores can't be imported either; add those by hand.
- **Banks that need re-authorization** (every few months for some) stop syncing until you reconnect on
  `/setup`. Set up email alerts to hear about it.
- **Cloudflare's Free plan allows 50 outbound requests per run.** An ordinary account sync makes about 6, so a
  run covers roughly 7 accounts; the rest sync on the next run, 15 minutes later. A bank that replays more
  history at once than one run can read (more than about 20,000 transactions in its feed, after a long
  outage) keeps failing with a "more new activity than one run can read" error; other banks still sync.
  On Workers Paid, raise the `SUBREQUEST_BUDGET` var.
