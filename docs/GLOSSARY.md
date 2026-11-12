# What the dashboard's words mean

Plain definitions of the terms you'll see on the dashboard, in Activity and in these docs. Several sound alike
but do very different things; the **Changes YNAB?** column is the quickest way to tell them apart.

## Buttons and actions

| Term | What it does | Changes YNAB? |
|---|---|---|
| **Sync now** | Asks Plaid to re-check your banks, then imports whatever Plaid already has that's new since the last sync. | Yes (unless Dry run is on) |
| **Dry run** | A switch, not a sync. While it's on, Sync now and Re-scan only show what they *would* do. | Never |
| **Re-check** | Re-reads bank and YNAB balances and refreshes **Account health**. Also called the *health check* or *audit* in Activity and in the code. | Never |
| **Re-scan** | Looks back over the last 7, 14 or 30 days for bank charges that aren't in YNAB and imports them. Doesn't move the sync's saved place in the bank feed. The API calls this *backfill*. | Yes (unless Dry run is on) |
| **Transaction reconcile** | Lines up bank transactions with YNAB rows, one by one, and lists anything on only one side. | Never |
| **Undo…** | Removes the rows one sync *added*. It doesn't reverse anything else that sync did. See [How it works](HOW-IT-WORKS.md#undo). | Yes (asks first) |
| **Pause all syncing / Resume** | Stops or restarts every write. Read-only checks keep working. | No |
| **Ask Plaid to refresh** | Asks Plaid to poll your banks now. New data arrives a few minutes later by webhook. | No |
| **Re-register webhooks** | Points every bank login's Plaid webhook at this worker, so new charges arrive within minutes. | No |
| **Reconnect** (on `/setup`) | Repairs a bank login that says *Needs reauth*. Same accounts, same history. | No |

## Per-account settings

| Term | Meaning |
|---|---|
| **Sync** | The worker may write to this account. Off means it never changes the account, not even in a dry run. |
| **Frequency** | How often the 15-minute schedule actually syncs this account. A webhook from its bank can sync it sooner. |
| **Import from the recent window (safety net)** | Also import posted charges from the last 7 days that the bank feed's normal updates missed. On for cards. Sometimes called the *catch-up window*. |
| **Include in health checks** | Re-check and the hourly check compare this account's balance with the bank. Read-only. |
| **Payments name it by last 4 / words** | How a payment *from* checking names this card, so it's booked as a transfer to it. |

## Words you'll see in Activity

| Term | Meaning |
|---|---|
| **Pending imported** | A charge the bank still shows as pending was added as an uncleared row (memo "Pending"). |
| **Pending posted** | That same row flipped to cleared, in place, when the charge posted. Nothing new was added. |
| **Pending removed** | A pending row was taken out because the bank no longer shows that charge as pending (it was dropped, or it posted as a different row). |
| **Already in YNAB (linked to your row)** | The charge was already in YNAB as a row you or Direct Import added, so the worker linked to it instead of adding another. |
| **Needs you: …** | Something the worker can't fix by itself, with what to do in the detail column. |
| **Setting up** (*bootstrap* in the API) | The first sync of an account: it imports what's pending now and anything posted since YNAB's newest import, and nothing older, because your YNAB starting balance already includes it. |

## Behind the scenes

| Term | Meaning |
|---|---|
| **Import id** | A stable id the worker gives each row so YNAB never imports the same charge twice. YNAB remembers import ids even after a row is deleted. |
| **Direct Import** | YNAB's own bank connection. This worker can run alongside it; whichever imports a charge first wins, and the other is linked, not duplicated. |
| **Skip rules** | Bank items never to import (a front-loaded paycheck you already entered, for example). |
| **Payee aliases** | Names that mean the same merchant, so matching treats them as one. |
| **Transfer labels** | Your accounts at other banks, named by their last digits, so transfers to them get a readable payee. |
| **Card payment cutoff** (`CC_TRANSFER_CUTOFF`) | Card payments dated before this stay part of the card's starting balance instead of becoming transfers. |
| **Reset card** (`POST /reset-card?account=<card>`, no dashboard button) | Rotates a credit card's import ids. Only for when you've deleted a card's worker rows in YNAB and want them re-imported: YNAB refuses import ids it has already seen, so new ones are needed. It refuses while worker rows are still in the register, because re-minting ids then would duplicate every charge. The next sync sets the card up again from what's pending now. |
