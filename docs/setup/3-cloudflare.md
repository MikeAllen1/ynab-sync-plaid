# 3. Cloudflare

The worker runs on Cloudflare Workers. The free plan is enough: no card needed.

## Account and subdomain

1. Sign up at <https://dash.cloudflare.com/sign-up> and verify your email.
2. In the dashboard open **Workers & Pages**. The first time, Cloudflare asks you to pick a
   **workers.dev subdomain**, e.g. `jane`. Your worker will live at `https://ynab-sync.jane.workers.dev`.
   (You can see or change it later under **Workers & Pages → Settings / Subdomain**.)
3. Now go back to [Plaid](1-plaid.md#allow-the-workers-address-for-banks-like-chase) and add
   `https://ynab-sync.<your subdomain>.workers.dev/setup` to the allowed redirect URIs.

## Tools on your computer

1. Install [Node.js](https://nodejs.org) (the LTS version). Check it in a terminal: `node -v` should print v18
   or newer.
2. Install [Git](https://git-scm.com/downloads), or download the repo as a ZIP from GitHub (**Code →
   Download ZIP**) instead.
3. Get the code and its tools:
   ```bash
   git clone https://github.com/MikeAllen1/ynab-sync-plaid.git
   cd ynab-sync-plaid
   npm install
   ```
4. Connect the command-line tool to your Cloudflare account (a browser window opens; click **Allow**):
   ```bash
   npx wrangler login
   ```

## Storage

The worker keeps its settings, your linked banks and its sync state in a KV namespace in your account:

```bash
npx wrangler kv namespace create SYNC_STATE
```

It prints a block with an `id = "…"`. Copy that id for the next step. (Older versions of the tool spell the
command `kv:namespace`.)

## What the free plan gives you

The worker runs a scheduled check every 15 minutes plus your dashboard visits, well inside the free plan's
daily requests. It reads and writes a little KV on each run. If Cloudflare ever emails you about limits,
lower how often accounts sync (dashboard → Settings) or pause syncing while you look into it.
