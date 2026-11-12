# 5. Everyday use and troubleshooting

## The dashboard

`https://ynab-sync.<you>.workers.dev/dashboard`

- The top shows whether every account's **bank balance matches YNAB**, any unexplained difference, and the last
  successful sync.
- **Sync now** runs right away (tick **Dry run** to preview).
- **Undo…** removes the rows a sync added (it shows you first). It doesn't reverse anything else that sync did:
  rows it marked posted, pending rows it removed, or amounts it updated stay as they are.
- **Settings → Global sync → Pause all syncing** stops everything until you resume.
- **Activity** lists what each run did and why something was skipped.

## A bank says "Needs reauth"

Banks make you sign in again every few months. Open `/setup` → **Reconnect** next to that bank and sign in.
Same accounts, same history; nothing is re-imported.

## Something looks wrong

| You see | Try |
|---|---|
| A charge is missing | Dashboard → **Re-scan** (7 days) with Dry run on, then off. Plaid sometimes lags the bank by a day. |
| A charge is in YNAB twice | Delete the extra in YNAB, then add a **payee alias** if the two rows had different names. |
| Card payment came in as a plain outflow | Set that card's **last 4 / words** in Settings so the payment is recognized. |
| "YNAB rejected the API token" | Make a new token in YNAB and `npx wrangler secret put YNAB_TOKEN`. |
| A Chase-style bank won't finish signing in | Check the **Allowed redirect URIs** in Plaid matches `https://…/setup` exactly. |
| Anything else | `npx wrangler tail` shows live logs while you click **Sync now**. |

## Updating to a new version

```bash
git pull
npm install
npx wrangler deploy
```

Your settings, banks and history live in Cloudflare, so updating doesn't touch them.

## Turning it off

Pause on the dashboard, or delete the worker in Cloudflare (**Workers & Pages → ynab-sync → Settings → Delete**).
To stop Plaid access completely, also remove the bank in your bank's own "connected apps" page.
