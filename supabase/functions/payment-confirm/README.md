# payment-confirm

Turns "a payment arrived" into "the player's wallet went up", exactly once.

```
POST https://qocrpleireoffykeendn.supabase.co/functions/v1/payment-confirm
```

## Why it exists before anything calls it

Philippine payment gateways will not onboard a wagering merchant — [PayMongo
lists gambling and betting as prohibited](https://paymongo.com/restricted-businesses),
[Xendit declines it outright](https://help.xendit.co/hc/en-us/articles/360035083951-Are-there-any-businesses-that-Xendit-prohibits) —
so there is no webhook to receive today.

That does not make this premature. The hard part of taking payments was never
the gateway; it is crediting the right wallet once and only once, under retries
and races. That part is identical whoever reports the payment: a gateway later,
a notification bridge, or the owner pressing a button. Building it now means the
day a feed exists, connecting it is configuration rather than a rewrite — and
nothing about it has to be thrown away if the licensing question changes.

## Request

```json
{
  "provider":   "paymongo",        // optional, defaults to "manual"
  "externalId": "pay_abc123",      // REQUIRED - the provider's own payment id
  "amount":     500,
  "reference":  "AET-X9K2",        // the pay code quoted by the payer
  "method":     "gcash",           // optional
  "payerName":  "Juan Dela Cruz"   // optional
}
```

`externalId` is what makes the call idempotent, so it must be the payment's own
identifier — not a timestamp, not a random value per attempt. A retry has to
carry the same one or it will be treated as a second payment.

`reference` is forgiving: `aet-x9k2`, `AET X9K2`, `aetx9k2`, `X9K2`, and
`payment AET-X9K2 thanks` all resolve to `AET-X9K2`. Anything with no
recognisable code is recorded as unmatched rather than guessed at.

## Outcomes

| `outcome` | what happened |
| --- | --- |
| `credited` | matched a pending request with the same amount; wallet credited |
| `review` | matched, but something needs a human: amount differs, no linked account, or the request was decided elsewhere first |
| `unmatched` | no pay code quoted, or no pending request waiting on it |
| `duplicate` (with `duplicate: true`) | already processed; nothing credited again |

Every call is recorded in `payment_events` whatever the outcome, including the
raw body, so a dispute can be settled from the record.

## How it cannot double-credit

Three things in this order, and the order is the design:

1. **Record first.** `payment_events` has a unique constraint on
   `(provider, external_id)`. A webhook retry loses that race *in the database*,
   not in application code that can race with itself.
2. **Claim second.** The request is taken with a conditional update out of
   `pending`. The owner's manual Approve button in `admin-actions` uses the same
   conditional update, so the automated path and the human path cannot both pay
   the same request — whichever gets there first wins, the other is told so.
3. **Move money last**, through the same `apply_wallet_delta` RPC the manual
   path uses. There is one money primitive, not two.

If the wallet move fails, the request is returned to `pending` exactly as
`admin-actions` does, so it is never left reading `approved` with nothing behind
it.

A retry of an event that was recorded but never finished is **resumed**, not
waved through. Returning "already processed" for an attempt that crashed before
crediting would swallow a real payment.

## Authentication

It fails closed. Two ways in:

- **`x-payment-secret`** matching the `PAYMENT_WEBHOOK_SECRET` edge secret —
  what an automated feed would send. Compared in length-independent time.
- **An admin JWT** in `Authorization: Bearer` — the owner, from the portal.

`PAYMENT_WEBHOOK_SECRET` is deliberately **not set**. While it is unset the
secret path is disabled entirely and only an admin can reach the function. Set
it in the Supabase dashboard (Edge Functions → Secrets) at the point you have
something to connect, not before.

`verify_jwt` is off at the platform level because a third-party webhook has no
Supabase JWT; the function does its own authentication instead.

## Verified

Run against the live deployment and database:

- Auth fails closed with no credentials, a wrong secret, and a junk bearer
  token; `GET` is refused; **nothing was written to `payment_events` by any
  rejected call**, so authentication really does precede the record.
- `(provider, external_id)` rejects a repeat with `unique_violation` — the
  guarantee everything else rests on — while still allowing two providers to
  use the same id for different payments.
- Negative amounts and unknown statuses are rejected by check constraints.
- The claim: the first conditional update takes the row, the second affects
  zero rows, and the row still belongs to the first claimant.
- The reference normaliser over 12 cases including junk and nulls.

RLS: one admin-only `SELECT` policy and no write policies at all, so players can
neither read the payment feed (it carries other people's names and amounts) nor
write to it; only the service role writes.

## Not yet verified

**An actual end-to-end credit.** That needs either an admin login or the shared
secret, and this environment has neither — creating throwaway accounts to get
one was blocked as a write to the live auth system, correctly. Specifically
untested: a real `credited` outcome and the balance that follows, the resume
path for a half-finished event, and concurrent HTTP calls racing each other.

The database-level guarantees underneath all of those *are* tested above, which
is where the actual risk lives. But the full path has not been run.
