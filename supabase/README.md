# Aetheris Arena — server side

The game's money and combat run on Supabase, not in the browser.

## Edge Functions (deployed, live)

| function | what it owns |
|---|---|
| `duel` | the entire combat simulation: deck, shuffle, card effects, bot moves, win/loss, escrow, payout |
| `shop` | hero and skill prices, win/EXP gates, purchases |
| `admin-actions` | top-up / withdrawal / registration decisions, freeze, manual balance adjustment |

All three require a valid JWT. `admin-actions` additionally checks the caller
is in `public.admins`.

Sources live in `supabase/functions/<name>/index.ts` and match what is
deployed. To work on them:

```bash
supabase link --project-ref qocrpleireoffykeendn
```

```bash
supabase functions deploy duel
```

To confirm the repo still matches production before you change anything:

```bash
supabase functions download duel --output-dir /tmp/live && diff /tmp/live/duel/index.ts supabase/functions/duel/index.ts
```

## Invariants the database enforces

- `profiles.wallet`, `wins`, `xp`, `status`, `approved`, `frozen`, `role`,
  `unlocked_heroes` and `unlocked_skills` are rejected on any client UPDATE by
  the `guard_profile_columns` trigger. Only the service role may change them.
- `apply_wallet_delta()` is the single path that moves a balance. It writes the
  ledger row in the same transaction, so balance and ledger cannot disagree.
  `EXECUTE` is revoked from `anon` and `authenticated`.
- `duel_sessions` has a partial unique index allowing one `active` duel per
  player, and settlement is a conditional update, so a duel pays out once.
- A duel's `seq` is the **reveal gate**, and every rule below reads it that
  way. `escrow` takes the stake and deals the hand into `duel_sessions.state`
  but returns only `{ duelId, stake, balance }`, leaving `seq = 0`. The board
  reaches the browser only through the `start` action, which moves `seq` to 1.
  Before that the player has seen neither their hand nor the opponent's hero,
  so `cancel` can refund in full without letting anyone shop for a draw; after
  it, `cancel` is refused with `409 The duel has already started`. `start` is
  idempotent — a second call returns the same board rather than dealing a new
  hand — so a dropped response or a refresh resumes instead of rerolling.
- Abandoned duels are swept by `expire_stale_duels()`, which runs at the start
  of every escrow. What happens depends on whether the board was ever dealt to
  the player: a duel with `seq = 0` (still searching) is **cancelled and the
  stake refunded** after 5 minutes, because closing the tab during the
  six-second search screen should not cost a wager; a duel with `seq > 0` is
  forfeited as a DEFEAT after an hour, because the hand was in the player's
  hands and walking away from a live wager has to cost something.
- Players read only their own rows. Other players are visible only through the
  `leaderboard` view (nickname, wins, xp — no email, phone or balance).

## Combat is server-authoritative

The browser sends `playCard`, `endTurn` or `surrender` and renders what comes
back. It never computes damage and never reports a result. Each request echoes
the `seq` it last rendered; a stale or replayed `seq` is refused with
`409 Out of sync`.

### The opponent

The opponent is a bot, and it plays by the player's rules: three AP a turn, a
hand of four dealt from its own deck, and each card's real effect applied.
It heals when badly hurt, otherwise spends its AP on the hardest-hitting cards
it can afford. Earlier it invented one flat number per turn, which made its
shields and heals land as 25-damage attacks and left its armour, healing and
poison unused; `playerPoison` was dead state because nothing ever set it.

Two things are matched to the player at escrow and then fixed for the duel:

- **Tier.** The opponent hero is drawn from the player's own rung of
  `HERO_LADDER`, give or take one. Drawn uniformly, a Pyra player met an Astral
  Archmage one duel in eleven and was flattened before acting.
- **Loadout.** `botDeckFor` gives the opponent as many of *its* hero's shop
  skills as the player owns of *theirs*, stored on the duel as `state.enemyDeck`.
  Unmatched, a player holding both shop skills won about three duels in four.

**Changing any of this changes the house margin, so measure it.** A win pays
2x stake less the 5% fee, so the arena breaks even at a 52.6% player win rate
and loses money above it. There is a simulator for exactly this: it imports
the real `botTurn`, `matchOpponentHero` and `botDeckFor` out of this file so
the numbers cannot drift from the shipped code.

Card effects live in the `duel` function's own table, generated from the game
data in `index.html`. **If you change a card's damage, armour, heal, poison or
AP in `index.html`, change it in the `duel` function too** — the page's copy is
for display only, and the server's copy is what actually applies.

## Where the database lives

Schema, RLS policies and the SQL functions above exist **only in the Supabase
project** — they are not in this repo. `supabase db pull` will write them into
`supabase/migrations/` if you want them versioned alongside the code.
