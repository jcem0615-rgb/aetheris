# Duel tools

## check-cards.mjs — run this after touching any card or the fee

```bash
node tools/duel-sim/check-cards.mjs
```

The card numbers live twice: the duel function applies them, `index.html`
displays them. If they drift, the arena quietly lies to players about what they
are buying and playing. The same check covers the platform fee, which the page
quotes to the player twice — a player told one rate while another is taken has
been overcharged, and that matters more than any card number being wrong.

The fee is charged on **one wager**, not on the combined pot: on a ₱100 bet the
pot is ₱200, the fee is ₱10 and the winner takes ₱190. The house therefore
keeps 5% of the money wagered while quoting 10%, because the rate is on the
bet. Both numbers are correct; they answer different questions.

Exits non-zero and names every field that disagrees.

## fairness.mts — run this after touching a card, a hero, or the pairing rules

```bash
node tools/duel-sim/extract.mjs
node --experimental-strip-types tools/duel-sim/fairness.mts
```

Measures whether two players the matchmaker is willing to pair get an even
fight. For every loadout (hero + how many of its shop skills are owned) it
plays the peers inside the server's opening power bracket, with the **same**
policy on both sides, so any difference comes from the cards rather than from
one side being played better.

A fair pairing sits near 50%. The tool exits non-zero if any loadout falls
outside 40–60%.

The hero ladder is deliberately unequal — that is the progression players pay
for. Fairness here does not mean every hero is equal; it means nobody is handed
a duel they were going to lose before the first card was played. That is what
the power bracket is for, and this measures the bracket.

**It has already caught one real problem.** A shop skill was first weighted 1
against a hero rung's 2. At the bottom of the ladder a paid skill roughly
doubles your damage — Pyra strikes for 26, her shop skills do 42 and 77 — so
`valen+0` and `valen+2` fell inside the same bracket and the buyer won 70.6%
of duels. At weight 3 everything sits inside the band. `SHOP_SKILL_WEIGHT` in
the duel function is that number.

Known residual: `valen+0` runs 39–44% and `void-necromancer+1` dips to ~38% on
some runs. That is hero design, not pairing — Valen is the armour hero with the
weakest offense, and was the worst hero in the game before the base decks were
regenerated. Worth revisiting if players avoid it.

## What happened to the house-margin simulator

`simulate.mts` measured the arena's edge against its own bot over 8000 duels a
run. There is no bot any more, and the house takes no position in a duel: it
earns the registration fee and a fixed cut of every pot, win or lose, so its
margin is now arithmetic rather than something to simulate. At a 10% fee on the wager the
house keeps 10% of one stake from every pot settled - 5% of the money wagered. The file is gone; `fairness.mts` replaced
the question it was answering.

`extract.mjs` used to slice the engine between `const PLATFORM_FEE` and
`function publicState`. When the bot went, so did `publicState` — and
`indexOf` returning -1 made `slice(start, -1)` hand back almost the whole file
instead of failing, so the script reported success while writing a module that
could not load. It now checks both markers and exits non-zero.
