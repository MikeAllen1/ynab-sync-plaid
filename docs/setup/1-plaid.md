# 1. Plaid

Plaid is the service that signs in to your bank and hands the worker your transactions.

> Plaid's dashboard is redesigned now and then. If a menu name here doesn't match, use the search box in
> the dashboard (top left) and search for the bold words.

## Create an account

1. Go to <https://dashboard.plaid.com/signup>.
2. When asked what you're building, choose **Personal use** ("I want to use Plaid's APIs to build something
   for fun"). In the US and Canada this gives you Plaid's free **Trial plan**: real bank data, up to
   **10 Items**. An Item is one bank login: a checking account and a credit card at the same bank count as one.
3. Make sure **Transactions** is one of the products on your plan.
4. Read the plan terms before you accept anything, especially anything about billing. If you later need more
   than 10 Items you'd have to move to a paid plan, and paid plans bill per Item per month for Transactions.

Want to try everything first without a real bank? Use the **Sandbox** environment (always free, fake banks)
and set `PLAID_ENV = "sandbox"` in the worker. In Sandbox, sign in to any test bank with `user_good` /
`pass_good`.

## Copy your keys

1. Open **Developers → Keys** (on the home page: **Get keys → View keys**).
2. Copy the **client_id** and the **Production** secret (or the Sandbox secret if you're testing).

These become the `PLAID_CLIENT_ID` and `PLAID_SECRET` secrets in [step 4](4-worker.md).

## Allow the worker's address (for banks like Chase)

Many big banks (Chase, Capital One, Wells Fargo, …) send you to their own website to sign in and then back to
the worker. Plaid only sends you back to addresses you've allowed.

1. Open **Developers → API** and find **Allowed redirect URIs** → **Configure** (or **+ Add**).
2. Add your worker's setup page, exactly, with `https://` and no trailing slash:
   ```
   https://ynab-sync.<your-subdomain>.workers.dev/setup
   ```
   You'll know `<your-subdomain>` after [step 3](3-cloudflare.md); come back and add it then.
3. Save.

## If a bank won't connect

- **"Institution not supported" or similar for a big bank**: open the dashboard's **OAuth institutions** page
  to see that bank's status. On the Trial plan most are available right away; a few need extra registration.
  Plaid support can tell you what's missing.
- **"Link customization / use case" error**: some newer Plaid teams have to pick a use case under
  **Link → Customization** before real banks work. Pick the closest one (personal finance / budgeting).
