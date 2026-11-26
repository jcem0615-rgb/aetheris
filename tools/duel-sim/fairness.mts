// Is a duel between two players fair?
//
// This replaces the old house-margin simulator, which measured the arena's
// edge against its own bot. There is no bot any more and the house takes no
// position: it earns the registration fee and a fixed cut of each pot, win or
// lose. So the number that matters is no longer "does the house profit" but
// "do two players the matchmaker is willing to pair get an even fight".
//
// The hero ladder is deliberately unequal - that is the progression players
// are paying for. Fairness therefore does not mean every hero is equal; it
// means nobody is handed a duel they were going to lose before the first card.
// The matchmaker enforces that with a power bracket, so this measures the
// bracket, not the ladder: for every pairing the server would actually make,
// how often does the stronger side win?
//
//   node tools/duel-sim/extract.mjs
//   node --experimental-strip-types tools/duel-sim/fairness.mts
import * as B from './botlogic.ts';
const { CARDS, HERO_BASE, HERO_SHOP, MAX_HP, AP_PER_TURN,
        deal, hit, deckFor, rnd, powerOf, toleranceFor } = B as any;

const HEROES: string[] = Object.keys(HERO_BASE);
const DUELS = 1200;          // per pairing
const OPENING_BRACKET = toleranceFor(0);   // what a fresh search accepts

type Side = {
  hero: string; hp: number; armor: number; ap: number; poison: number;
  deck: string[]; hand: string[];
};

function side(hero: string, owned: Record<string, boolean>): Side {
  const deck = deckFor(hero, owned);
  return { hero, hp: MAX_HP, armor: 0, ap: AP_PER_TURN, poison: 0, deck, hand: deal(deck) };
}

// One policy, used by BOTH sides, so any difference in outcome comes from the
// cards rather than from one side being played better than the other. Heal
// when badly hurt, otherwise spend AP on the hardest-hitting affordable card.
function takeTurn(me: Side, foe: Side) {
  for (let guard = 0; guard < 8; guard++) {
    const affordable = me.hand
      .map((id, i) => ({ i, c: CARDS[id] }))
      .filter((x: any) => x.c && x.c.ap <= me.ap);
    if (!affordable.length) break;

    let choice = me.hp < MAX_HP * 0.35
      ? affordable.filter((x: any) => x.c.heal > 0).sort((a: any, b: any) => b.c.heal - a.c.heal)[0]
      : undefined;
    if (!choice) {
      const atk = affordable.filter((x: any) => x.c.damage > 0);
      choice = atk.length
        ? atk.sort((a: any, b: any) => b.c.damage - a.c.damage)[0]
        : affordable.sort((a: any, b: any) => (b.c.armor + b.c.heal) - (a.c.armor + a.c.heal))[0];
    }

    const c = choice.c;
    me.ap -= c.ap;
    me.hand.splice(choice.i, 1);
    if (c.damage) {
      const r = hit(c.damage, foe.armor);
      foe.armor = r.armor;
      foe.hp = Math.max(0, foe.hp - r.dmg);
    }
    if (c.armor) me.armor += c.armor;
    if (c.heal) me.hp = Math.min(MAX_HP, me.hp + c.heal);
    if (c.poison) foe.poison += c.poison;
    if (foe.hp <= 0) return;
  }
}

// Returns true if side A won.
function duel(heroA: string, ownedA: Record<string, boolean>,
              heroB: string, ownedB: Record<string, boolean>): boolean {
  const a = side(heroA, ownedA), b = side(heroB, ownedB);
  let turn = rnd(2) === 0 ? a : b;   // the server flips for initiative too

  for (let t = 0; t < 200; t++) {
    const other = turn === a ? b : a;
    takeTurn(turn, other);
    if (other.hp <= 0) return turn === a;

    // burn ticks on the player being handed the turn, as in the engine
    if (other.poison > 0) {
      other.hp = Math.max(0, other.hp - other.poison);
      other.poison = Math.max(0, other.poison - 2);
      if (other.hp <= 0) return turn === a;
    }
    other.ap = AP_PER_TURN;
    other.hand = deal(other.deck);
    turn = other;
  }
  return a.hp >= b.hp;             // timeout: closest to alive
}

// Each hero at each level of investment it can reach.
const LOADOUTS: { hero: string; owned: Record<string, boolean>; power: number; label: string }[] = [];
for (const hero of HEROES) {
  const shop: string[] = HERO_SHOP[hero] ?? [];
  for (let n = 0; n <= shop.length; n++) {
    const owned: Record<string, boolean> = {};
    for (let i = 0; i < n; i++) owned[shop[i]] = true;
    LOADOUTS.push({ hero, owned, power: powerOf(hero, owned),
                    label: `${hero}+${n}` });
  }
}

console.log(`Aetheris PvP fairness, ${DUELS} duels per pairing.`);
console.log(`Pairings are those the matchmaker makes on a fresh search: power within ` +
            `${OPENING_BRACKET}. A fair pairing sits near 50%.\n`);

let worst = { label: '', rate: 50, vs: '' };
const offenders: string[] = [];
let pairings = 0;

for (const A of LOADOUTS) {
  const peers = LOADOUTS.filter((C) => Math.abs(C.power - A.power) <= OPENING_BRACKET
                                        && C.label !== A.label);
  if (!peers.length) continue;
  let wins = 0, played = 0;
  for (const C of peers) {
    for (let i = 0; i < DUELS / peers.length; i++) {
      if (duel(A.hero, A.owned, C.hero, C.owned)) wins++;
      played++;
    }
  }
  pairings++;
  const rate = (wins / played) * 100;
  const flag = rate < 40 || rate > 60 ? '  <-- OUTSIDE 40-60' : '';
  if (flag) offenders.push(`${A.label} (power ${A.power}) wins ${rate.toFixed(1)}%`);
  if (Math.abs(rate - 50) > Math.abs(worst.rate - 50)) {
    worst = { label: A.label, rate, vs: peers.map((p) => p.label).join(', ') };
  }
  console.log(`  ${A.label.padEnd(22)} power ${String(A.power).padStart(2)}   ` +
              `wins ${rate.toFixed(1)}%   vs ${peers.length} peer loadout(s)${flag}`);
}

console.log(`\n${pairings} loadouts measured against the peers they can be paired with.`);
if (offenders.length) {
  console.log('\nOutside the 40-60% band:');
  for (const o of offenders) console.log('  ' + o);
  console.log('\nA loadout well outside that band is one players will either flock to or ' +
              'avoid, and the player paired into it is losing money to the matchmaker ' +
              'rather than to the opponent.');
} else {
  console.log('Every pairing the matchmaker will make sits inside 40-60%.');
}
console.log(`\nFurthest from even: ${worst.label} at ${worst.rate.toFixed(1)}%`);
process.exit(offenders.length ? 1 : 0);
