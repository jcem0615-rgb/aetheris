# PvP duel tests

Two tests for player-versus-player duels, both run against the **live** site and
the **live** database. They move real money between real accounts, so they need
two funded test players and they leave ledger rows behind.

- `api-pvp.mjs` — drives the deployed `duel` edge function directly with two
  JWTs. Fast, and precise about the things that matter for money: pairing,
  both escrows, turn enforcement, the `seq` replay guard, the payout, and that
  the loser's poll is answered rather than refused.
- `browser-pvp.mjs` — drives two real Chromium sessions through the site with
  real clicks. Slower, and the only thing that catches what the player actually
  sees: that the waiting player's hand is click-blocked and says why, that each
  side sees the other's nickname and hero, and that the result dialog quotes the
  right figures.

Run the API one first. If the engine is wrong, the browser run only tells you
the same thing more slowly.

## Setup

Both read credentials from the environment; nothing about the accounts is
committed.

```bash
export PVP_A_EMAIL='...' PVP_A_PASS='...'
export PVP_B_EMAIL='...' PVP_B_PASS='...'
```

Each account must be `approved`, unfrozen, hold at least the stake (default
₱100), and have an `active_hero` that is on its `unlocked_heroes` roster —
otherwise the function refuses to queue it, which is the intended behaviour and
not a test failure. Give the two players **different** heroes: that is what
proves the board is rendered from each player's own seat rather than from one
fixed point of view.

```bash
node api-pvp.mjs
node browser-pvp.mjs      # writes screenshots to ./shots
```

## If a run dies partway

A crashed run can leave a duel `active` with both stakes escrowed. Nothing
reclaims that automatically for two minutes, and until then neither player can
start another duel — one active duel per player is enforced in the database.

To void it and return both stakes:

```sql
do $$
declare r record;
begin
  for r in select id, user_id, opponent_user_id, stake
             from public.duel_sessions where mode='pvp' and status='active'
  loop
    update public.duel_sessions set status='cancelled', settled_at=now() where id=r.id;
    perform public.apply_wallet_delta(r.user_id, r.stake,
      'Ranked Duel wager refunded (test harness duel voided)', 'CREDIT');
    perform public.apply_wallet_delta(r.opponent_user_id, r.stake,
      'Ranked Duel wager refunded (test harness duel voided)', 'CREDIT');
  end loop;
  delete from public.matchmaking_queue;
end $$;
```

Waiting instead of running that is also fine: `expire_stale_duels` forfeits the
side on the clock after two minutes and pays the other player, which is the
production behaviour for a player who walks away.

## Notes for whoever edits these

The page keeps its duel state in a closure, not on `window`, so the browser test
reads everything off the rendered HUD — `#fs-player-hp-text`, `#fs-player-ap`,
`#fs-enemy-name-label`, the card count under `#shuffled-hand-container`, and
`#btn-end-turn.disabled` for whose turn it is. That is deliberate: it is also a
truer test. Do not "fix" it by exposing internals.

The hand re-renders on every poll and goes `pointer-events: none` the instant
the turn flips, so a click can land on a node that is already gone. Every click
is given a short timeout and a miss just re-reads the board. A dropped click is
the driver being faster than a person, not a bug — confirmed by checking
`elementFromPoint` at the card's centre, which lands inside the card for the
player on the clock.

`import` does not follow Node's global module resolution, so `playwright` is
reached through `createRequire('/opt/node-tools/')`. Adjust that path if the
preinstalled copy moves.
