# Duel simulator

Measures the arena's house margin against the **real** combat code. `extract.mjs`
slices the pure logic (`botTurn`, `matchOpponentHero`, `botDeckFor`, the card
tables) straight out of `supabase/functions/duel/index.ts`, so the numbers can
never drift from what is deployed.

```bash
node tools/duel-sim/extract.mjs
node --experimental-strip-types tools/duel-sim/simulate.mts
```

A win pays `2 x stake x (1 - 5% fee)` = 1.9x, so the arena **breaks even at a
52.6% player win rate** and loses money above it. Run this before and after any
change to a card's numbers, the bot, the hero ladder or the shop, and check the
house margin is still positive for both populations: players who own shop
skills and players who do not.

The simulated player is a competent human — heals below 35 HP, otherwise spends
AP on the hardest-hitting affordable card. A weaker policy flatters the house,
so treat these win rates as the pessimistic end.

## Checking the two card tables agree

The card numbers live twice: the duel function applies them, `index.html`
displays them. If they drift, the arena quietly lies to players about what
they are buying and playing.

```bash
node tools/duel-sim/check-cards.mjs
```

It exits non-zero and names every field that disagrees. Run it after changing
a card in either file.
