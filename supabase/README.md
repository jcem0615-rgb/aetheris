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
2x stake less the 5% fee, so the arena breaks even at a 52.6% player win rate
and loses money above it. `tools/duel-sim` exists for exactly this: it imports
the real `botTurn`, `matchOpponentHero` and `botDeckFor` out of this file so
the numbers cannot drift from the shipped code. Where it stands, over 12000
duels per population:

| | win rate | house | lost before moving |
|---|---|---|---|
| no shop skills | 50.2% | +4.6% | 0% |
| both shop skills | 50.2% | +4.5% | 0% |

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

**Hero win rates are not flat without paid skills.** On base decks alone Valen
and Storm Knight sit near 25% while Nyx, Void and Ironclad clear 65%, so the
hero a player owns still swings their odds far more than it should. Valen's
base cards are the clearest case: SHIELD BASH hits for 26, less than Pyra's
28 at the bottom of the ladder. The aggregate is break-even either way, so this
is a fairness problem rather than a money one, and it is base card design.

Card effects live in the `duel` function's own table, generated from the game
data in `index.html`. **If you change a card's damage, armour, heal, poison or
AP in `index.html`, change it in the `duel` function too** — the page's copy is
for display only, and the server's copy is what actually applies.

## Where the database lives

Schema, RLS policies and the SQL functions above exist **only in the Supabase
project** — they are not in this repo. `supabase db pull` will write them into
`supabase/migrations/` if you want them versioned alongside the code.
