# Provably fair coin toss

How Aetheris decides who moves first, and how a player proves to themselves
that nobody chose it for them.

## The problem

Moving first in a duel is worth something. The player who opens lands the first
card before the opponent has armour up, and on a 100 HP board that edge is real.
So whoever decides turn order is deciding part of the outcome of a wager.

Today the server decides it alone:

```ts
turn: rnd(2) === 0 ? "a" : "b",     // duel/index.ts
```

That is genuinely random — `rnd` is `crypto.getRandomValues()` on the server, and
`% 2` over a uint32 is exactly even, because 2³² divides by two with nothing left
over. There is no bias in it.

But a player cannot see any of that. They have to take the arena's word for it,
and "trust us, it was random" is exactly what a rigged platform also says. The
point of this design is to stop asking for that trust.

## The scheme

Commit–reveal, with entropy from both sides.

1. **Commit.** When the duel is created, the server draws a 32-byte
   `server_seed` and publishes `commit = SHA-256(server_seed)` to both players.
   The seed itself is withheld.
2. **Call.** One player is nominated the caller. They pick **HEADS** or
   **TAILS** and their client sends a `client_seed` alongside it — 16 random
   bytes the client drew itself.
3. **Resolve.** The outcome is computed from both seeds:

   ```
   digest  = HMAC-SHA256(key = server_seed, message = client_seed + ":" + duel_id)
   face    = (digest[0] & 1) === 0 ? "HEADS" : "TAILS"
   ```

   If `face` equals the call, the caller moves first. Otherwise the opponent does.
4. **Reveal.** The server publishes `server_seed`. Both clients check
   `SHA-256(server_seed) === commit` and recompute `face` for themselves.

## Why this is sound

**The server cannot react to the call.** It committed to `server_seed` before
the call existed, and `face` depends only on the two seeds — not on which side
was called. Changing the seed afterwards breaks the hash the player already
holds.

**The caller cannot steer it either.** They choose `client_seed` freely, but
without `server_seed` the digest is unpredictable, so grinding seeds is no
better than guessing.

**A dishonest seed buys nothing.** Even a server that picked `server_seed`
deliberately rather than randomly has to pick it *before* knowing the call. The
call is free and unconstrained, so each player still faces an even chance. The
commit is what forces that ordering.

**The call confers no advantage, and that is the point.** HEADS and TAILS are
worth exactly the same. Letting a player call is a trust ritual, not an edge —
which is also why it does not matter who gets to call.

## What it does not prove

Worth stating plainly rather than letting the phrase "provably fair" do work it
has not earned:

- It proves the outcome was **fixed before the call** and **matches the published
  commit**. That is the whole claim.
- It does not prove the commit was generated before the call in wall-clock
  terms. A player sees the commit in the duel state before they call, so they
  can satisfy themselves at the time — but it is their own client telling them
  that. Third-party proof of ordering would need external timestamping, which
  this design does not attempt.
- It says nothing about the card shuffle, which uses the same RNG but is not
  covered by any commit. The shuffle is a separate piece of work.

## Data model

```sql
-- the secret, in a table with NO policies at all: the service role writes and
-- reads it, and nothing else can touch it. duel_sessions already has no
-- player-read policy, but a seed is worth a second lock of its own rather than
-- relying on a view never being careless with select *.
create table public.duel_toss_secrets (
  duel_id     uuid primary key references public.duel_sessions(id) on delete cascade,
  server_seed text not null,
  created_at  timestamptz not null default now()
);
alter table public.duel_toss_secrets enable row level security;
-- deliberately no policies; service_role bypasses RLS

-- everything a player is allowed to see, on the duel itself
alter table public.duel_sessions
  add column toss_commit       text,
  add column toss_client_seed  text,
  add column toss_call         text check (toss_call in ('HEADS','TAILS')),
  add column toss_caller       uuid,
  add column toss_face         text check (toss_face in ('HEADS','TAILS')),
  add column toss_server_seed  text,          -- null until the reveal
  add column toss_called_at    timestamptz,
  add column toss_auto         boolean not null default false;
```

`toss_server_seed` is written only at reveal. Before that it is null, so even a
future policy that exposed the row could not leak it early.

## Duel phases

A duel gains one phase before play:

```
awaiting_toss  ->  playing  ->  settled
```

`PvpState` carries `phase: "awaiting_toss" | "playing"`, the caller's seat, and
the toss fields. `pvpPublicState` sends the commit from the start, the call and
face once called, and the server seed only after the reveal — the same filtering
discipline that already keeps a hand private.

## The timeout matters more than it looks

**Both stakes are already escrowed when the toss happens.** `findMatch` debits
each player right after the duel row is inserted, so a toss that never resolves
is two players' money sitting in a duel that cannot start.

So the toss cannot depend on the caller showing up:

- The caller has **20 seconds** to call.
- After that, any `getState` from either player resolves it automatically: the
  server calls **HEADS** on the caller's behalf, using a `client_seed` it draws
  itself, and marks `toss_auto = true`.
- The auto-call is still verifiable. The same commit, the same formula, the same
  reveal. It is only the choice of side that was made for them, and that choice
  is worth nothing.

A player who disconnects therefore loses no money and gains no advantage, and the
duel starts on time for the opponent who did turn up.

## Resolution is claim-first

The toss is resolved with a conditional update out of `awaiting_toss`, the same
pattern the top-up and withdrawal queues use:

```sql
update duel_sessions set ... where id = $1 and state->>'phase' = 'awaiting_toss'
```

Two clients polling at once, or a call racing its own timeout, cannot both
resolve it. Whoever flips the phase owns the result; the other read just returns
the state that is now there.

## API

All through `functions/v1/duel`, which already authenticates and holds the
service key.

### `getState` / `start` (existing, extended)

While `phase = "awaiting_toss"` the view adds:

```jsonc
{
  "phase": "awaiting_toss",
  "toss": {
    "commit": "9f2c…",          // SHA-256 of the withheld seed
    "callerIsMe": true,          // whose turn it is to call
    "callerNick": "Nyx",
    "secondsLeft": 14
  }
}
```

### `tossCall` (new)

```jsonc
// request
{ "action": "tossCall", "duelId": "…", "call": "HEADS", "clientSeed": "8a1f…" }
```

Rejected unless the caller is this user, the phase is `awaiting_toss`, `call` is
one of the two faces, and `clientSeed` is 16–64 hex characters.

### After resolution

Both players see the same thing:

```jsonc
{
  "phase": "playing",
  "myTurn": false,
  "toss": {
    "commit":     "9f2c…",
    "serverSeed": "4b70…",      // now revealed
    "clientSeed": "8a1f…",
    "call":       "HEADS",
    "face":       "TAILS",
    "auto":       false,
    "firstMove":  "Storm Knight",
    "verify":     "HMAC_SHA256(serverSeed, clientSeed + ':' + duelId)[0] & 1"
  }
}
```

## What the player sees

**Before:** a panel showing the commit hash and, for the caller, two large
buttons — HEADS and TAILS — with the countdown. The opponent sees the same hash
and *"Nyx is calling…"*, so both know a call is pending and neither is waiting
on something invisible.

**During:** the coin animation, shown to both.

**After:** the result, who moves first, and a **Verify this toss** link that
opens the commit, both seeds, the formula and the recomputed face — with the
check mark that `SHA-256(serverSeed)` really does equal the commit the player
was shown before they called.

**In history:** the toss record stays on the settled duel, so a player can go
back and check a duel from last week.

## Verifying by hand

Nothing in this needs our code to check. Any machine with a shell:

```bash
# the commit the arena showed you before you called
echo -n "<serverSeed>" | xxd -r -p | sha256sum

# the face
printf '%s' "<clientSeed>:<duelId>" \
  | openssl dgst -sha256 -mac HMAC -macopt hexkey:"<serverSeed>" -hex
# first byte even -> HEADS, odd -> TAILS
```

If the first command does not reproduce the commit, the arena changed the seed
and the result is void. That is the point of publishing it.

## Build order

1. Migration: the secrets table and the `toss_*` columns.
2. `findMatch`: draw the seed, store it, publish the commit, start in
   `awaiting_toss` instead of assigning `turn` directly.
3. `tossCall` and the timeout path in `getState`.
4. Client: the call panel, the coin, the result and the verify sheet.
5. Keep `turn_user_id` in sync when the toss resolves — the realtime queue and
   the owner's views read it.

## A note on the shuffle

The deck is shuffled with the same `rnd`, and `rnd(n)` for an `n` that is not a
power of two carries a small modulo bias — negligible at deck sizes (about one
part in a hundred million) but not zero, and not covered by any commit. If
provable fairness is ever extended past the toss, the shuffle is the next thing
to bring under it, and `rnd` should get rejection sampling at the same time.
