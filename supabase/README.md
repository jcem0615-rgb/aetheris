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

**The sources are deployed but not yet committed here.** Pull them into git:

```bash
supabase link --project-ref qocrpleireoffykeendn
```

```bash
supabase functions download duel && supabase functions download shop && supabase functions download admin-actions
```

Then commit `supabase/functions/`, and deploy future changes with
`supabase functions deploy <name>`.

## Invariants the database enforces

- `profiles.wallet`, `wins`, `xp`, `status`, `approved`, `frozen`, `role`,
  `unlocked_heroes` and `unlocked_skills` are rejected on any client UPDATE by
  the `guard_profile_columns` trigger. Only the service role may change them.
- `apply_wallet_delta()` is the single path that moves a balance. It writes the
  ledger row in the same transaction, so balance and ledger cannot disagree.
  `EXECUTE` is revoked from `anon` and `authenticated`.
- `duel_sessions` has a partial unique index allowing one `active` duel per
  player, and settlement is a conditional update, so a duel pays out once.
- Players read only their own rows. Other players are visible only through the
  `leaderboard` view (nickname, wins, xp — no email, phone or balance).

## Combat is server-authoritative

The browser sends `playCard`, `endTurn` or `surrender` and renders what comes
back. It never computes damage and never reports a result. Each request echoes
the `seq` it last rendered; a stale or replayed `seq` is refused with
`409 Out of sync`.

Card effects live in the `duel` function's own table, generated from the game
data in `index.html`. **If you change a card's damage, armour, heal, poison or
AP in `index.html`, change it in the `duel` function too** — the page's copy is
for display only, and the server's copy is what actually applies.
