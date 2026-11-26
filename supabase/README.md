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

## Registration

A sign-up is a real Supabase auth account. `auth.signUp` carries the details as
metadata and the `handle_new_user` trigger turns them into a `profiles` row with
`status = 'pending_registration'`, an empty roster and no active hero, until the
owner approves it.

**One account per person, enforced in the database, not the page:**

- email: unique twice over, including a `lower(email)` index so case cannot
  slip a second account through
- phone: unique on `normalize_ph_phone(phone)`, so `0917 123 4567`,
  `+639171234567` and `9171234567` are all the same number. Blank numbers are
  excluded from the index so they do not collide. The page's long-standing
  claim that this was "enforced" was true of the email and false of the phone
  until this index existed.

`phone_in_use(text)` lets the sign-up page say so before calling `signUp`,
rather than surfacing a constraint violation as "Database error saving new
user". It is SECURITY DEFINER because a visitor cannot read `profiles`, and it
answers only yes or no.

The 50-peso fee is collected outside the app against an uploaded receipt, and
is recorded on the profile at approval as `registration_fee`. It is **not** a
wallet credit: it is revenue, not balance the player can wager or withdraw. In
exchange the player claims one starter hero through `claimStarter`, once, and
the other three stay on sale at 200 pesos.

A player reaches the arena when, and only when, all of these hold: approved,
not frozen, a valid stake, enough balance, a non-empty roster, and an active
hero they actually own. `escrow` checks every one of them server-side.

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

**Initiative is a coin flip**, decided at escrow as `state.botFirst` and acted
on by `start`: when the opponent wins it, it takes its opening swing before the
board is handed over, and the player opens the arena already down some HP. The
player used to open every duel, and because a three-AP turn can out-damage the
whole HP pool, the better opening hand simply won before the opponent acted.
That one change took the house from -30.8% to +4.4%.

**The HP pool is 150, not 100,** and that is load-bearing. At 100, a coin flip
meant 19.2% of duels for shop-skill owners ended before the player touched a
card -- paying a stake and losing without playing. Capping the opponent's
opening AP fixes the feel and wrecks the economics (-18.3% at 1 AP). Raising
the pool so no single turn can empty it fixes both: duels run long enough for
both sides to play, and nobody loses before moving.

Two more things are matched to the player at escrow and then fixed for the duel:

- **Tier.** The opponent hero is drawn from the player's own rung of
  `HERO_LADDER`, give or take one. Drawn uniformly, a Pyra player met an Astral
  Archmage one duel in eleven and was flattened before acting.
- **Loadout.** `botDeckFor` gives the opponent as many of *its* hero's shop
  skills as the player owns of *theirs*, stored on the duel as `state.enemyDeck`.
  Unmatched, a player holding both shop skills won about three duels in four.

**Changing any of this changes the house margin, so measure it.** A win pays
2x stake less a 10% fee on one wager, so a 100 bet pays 190
and loses money above it. `tools/duel-sim` exists for exactly this: it imports
the real `botTurn`, `matchOpponentHero` and `botDeckFor` out of this file so
the numbers cannot drift from the shipped code. Where it stands, over 12000
duels per population:

| | win rate | spread across heroes | house | lost before moving |
|---|---|---|---|---|
| no shop skills | 50.7% | 48-53% | +3.6% | 0% |
| both shop skills | 50.4% | 45-55% | +4.1% | 0% |

These are the numbers with `deal()` fixed. It used to re-evaluate its loop
bound against a pool that shrinks as cards leave it, so a four-card deck dealt
**two** cards and a six-card deck dealt **three** -- every hand in the game,
the opponent's included, had been short since server-side combat shipped. The
balance survived the fix because it was fitted on relative power, which a
bigger hand scales for both sides at once.

### The paid skills

Generated from the base numbers they upgrade, so the shop ladder cannot invert
and a paid skill is never a downgrade. Two rules it has to obey:

- **A 2-AP paid skill beats the signature it replaces; a 3-AP one beats the
  free strike + signature.** Before this, the flat-priced tier-3 skill dealt
  *less* than two base cards for every hero from Chrono upward -- Astral's
  BIG BANG did 120 against a free 137.
- **Nothing may one-shot from full health.** The cap is 142 of the 150 pool,
  and it is the ladder-wide tightest constraint, not each hero's own. A 2-AP
  skill is played alongside the 1-AP strike, and the strike RISES with tier, so
  capping each hero against its own strike inverts the ladder -- the top hero
  ends up with the smallest paid skill. That bug was caught by the validator,
  not by eye.

Base burst reaches 137 at the top of the ladder, so four of the eleven 3-AP
skills sit pinned at the cap and the top-tier upgrade is only +5 damage. The
value there is carried by the flavour, not the burst. Raising MAX_HP is the
only lever that would open that up, and it would need the whole ladder
re-measured.

**Buying skills cannot raise a player's win rate**, because `botDeckFor`
mirrors the loadout onto the opponent. That is deliberate -- an edge players
can buy is a house loss -- but it means the shop sells bigger numbers and
flashier effects, not better odds. Worth knowing before advertising otherwise.

Card text states only what the engine applies. It previously promised armour
piercing, shock, shattered defences and Armor-Break, none of which exist, and
called every hit "true damage" while `hit()` subtracts armour from all of it.

The card numbers live twice -- the function applies them, `index.html` displays
them -- so `node tools/duel-sim/check-cards.mjs` fails on any disagreement
between the two. Run it after touching either.

Every paid skill deals damage. Valen's AEGIS FORTRESS and DIVINE
INVINCIBILITY and Chrono's TEMPORAL REWIND and ETERNAL TIME COLLAPSE once dealt
**none** -- pure armour and pure healing -- so buying them crowded the
four-card hand with cards that could not close a duel, and those two heroes won
12% and 19% of duels. They now strike at a small discount to the pure-damage
cards of their tier and keep their signature on top: Valen's hit behind armour,
Chrono's hit that rewinds its own wounds. Both now sit near 50%, and the stalled
duels that heal-only decks produced are gone.

### The base decks and the hero ladder

Every hero has four cards in fixed roles: a 1-AP strike, a 1-AP guard, a 2-AP
signature and a 2-AP sustain. **All four come off one power curve**, so at a
given tier every hero has the same strike, guard and signature damage. A hero's
best turn is therefore the same number for everyone on that rung, and it rises
monotonically up the ladder -- `tools/duel-sim` asserts this, and two earlier
attempts at balancing were thrown away for inverting it.

Flavour is the only thing that differs, in three groups: burn (Pyra, Sylph,
Nyx, Void), healing (Storm, Chrono, Valkyrie, Berserker, Astral) and armour
(Valen, Ironclad). Their magnitudes are set so the three are **worth the same**,
which is what was broken: a pure heal was worth far less than a poison stack.

Two consequences worth knowing before touching a number:

- **Slot 4 always attacks.** It was a pure heal for six heroes and armour+heal
  for Valen, costing 2 of 3 AP and dealing nothing, which is why Valen won 23%
  of duels and Storm Knight 29%. Spread across the ladder, hero win rates ran
  22% to 73%; they now run 43% to 53%.
- **Burst must stay under the HP pool.** A hero's best turn is strike +
  signature, and at the top of the ladder that is 137 against 150 HP. Push the
  curve much higher and duels end before the second player acts, which is the
  failure mode the 150 HP pool exists to prevent.

The tier ends are not 50% and should not be: the bottom hero never meets
anything weaker and the top never meets anything stronger, so Pyra sits near
43% and Astral near 53%. Both stay inside the 52.6% break-even, so no hero is
profitable to farm.

Card effects live in the `duel` function's own table, generated from the game
data in `index.html`. **If you change a card's damage, armour, heal, poison or
AP in `index.html`, change it in the `duel` function too** — the page's copy is
for display only, and the server's copy is what actually applies.

## Where the database lives

Schema, RLS policies and the SQL functions above exist **only in the Supabase
project** — they are not in this repo. `supabase db pull` will write them into
`supabase/migrations/` if you want them versioned alongside the code.

## Player versus player duels

A PvP duel is one `duel_sessions` row with `mode = 'pvp'`, shared by two
players: `user_id` is seat **a**, `opponent_user_id` is seat **b**, and
`turn_user_id` is whoever is on the clock. The stored state belongs to nobody's
point of view - two symmetric seats plus whose turn it is - and each request is
answered from the caller's own seat using the same field names a bot duel
sends, so the page renders either kind without knowing the difference.

**A player is only ever sent their own hand.** The opponent's cards are
reported as a count, never as ids.

### The money

| event | who pays | who is paid |
|---|---|---|
| waiting in the queue | nobody | - |
| pairing | both players, one stake each | - |
| a player is defeated | - | winner gets `stake x (2 - 0.10)` |
| a player surrenders | - | the other gets `stake x 2 x 0.90` |
| a player abandons (2 min) | - | the side NOT on the clock gets the same |

Nothing is staked while a player waits, so a long search never locks up money.
Both debits happen at the moment a pair is formed, after the duel row inserts -
it is cheaper to undo an insert than to refund two debits, and the
one-active-duel guard on that insert is what stops either side being pulled
into two duels at once.

The house keeps `stake x 2 x 0.05` of every pot. Unlike a bot duel, the losing
stake is another player's rather than the house's, so PvP volume carries no
variance for the owner at all: the rake is collected whoever wins.

### Settling

`duel_sessions.result` holds `WINNER:<uuid>` for a PvP duel, not `VICTORY` or
`DEFEAT` - the row is shared, so the outcome has to name a player. Per-player
`VICTORY`/`DEFEAT` rows go into `battle_history`, which is what the client and
the owner's reports read.

Two rules that cost real money when they were broken:

- **A settle that fails must never be reported as a win.** `settlePvp` raises
  on a write error and only treats "no rows updated" as benign, because that
  one means another request settled the duel a moment earlier. Reading only
  `data` and ignoring `error` once left a duel active with both stakes taken
  and nobody paid.
- **A settled PvP duel must still answer the loser.** Their client is polling
  `getState` when the opponent lands the killing blow, so by the time the poll
  arrives the duel is no longer active. It returns the final board and the
  result rather than "already finished", or the loser sits in the arena never
  learning they lost.
