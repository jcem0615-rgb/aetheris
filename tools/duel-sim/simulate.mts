// Measures the arena's house margin against the real combat code.
// Regenerate botlogic.ts first:  node tools/duel-sim/extract.mjs
import * as B from './botlogic.ts';
const { CARDS, HERO_BASE, HERO_SHOP, MAX_HP, AP_PER_TURN, deal, hit, deckFor,
        matchOpponentHero, botDeckFor, botTurn, rnd, OPENING_AP } = B as any;
const HEROES = Object.keys(HERO_BASE);

// A competent human: heal when badly hurt, otherwise spend AP on the hardest
// hitting affordable card. A weaker policy flatters the house, so read these
// win rates as the pessimistic end.
function playerTurn(s: any) {
  for (let g = 0; g < 12; g++) {
    const aff = s.hand.map((id: string, i: number) => ({ i, c: CARDS[id] }))
                      .filter((x: any) => x.c && x.c.ap <= s.playerAp);
    if (!aff.length) break;
    let ch = s.playerHp < MAX_HP * 0.35
      ? aff.filter((x: any) => x.c.heal > 0).sort((a: any, b: any) => b.c.heal - a.c.heal)[0]
      : undefined;
    if (!ch) {
      const d = aff.filter((x: any) => x.c.damage > 0);
      ch = d.length ? d.sort((a: any, b: any) => b.c.damage - a.c.damage)[0]
                    : aff.sort((a: any, b: any) => (b.c.armor + b.c.heal) - (a.c.armor + a.c.heal))[0];
    }
    const c = ch.c; s.playerAp -= c.ap;
    if (c.damage) { const r = hit(c.damage, s.enemyArmor); s.enemyArmor = r.armor; s.enemyHp = Math.max(0, s.enemyHp - r.dmg); }
    if (c.armor) s.playerArmor += c.armor;
    if (c.heal) s.playerHp = Math.min(MAX_HP, s.playerHp + c.heal);
    if (c.poison) s.enemyPoison += c.poison;
    s.hand.splice(ch.i, 1);
    if (s.enemyHp <= 0) return 'PLAYER';
  }
  return null;
}

// Mirrors escrow + start + the endTurn loop in the duel function.
function duel(heroId: string, owned: any) {
  const enemyHeroId = matchOpponentHero(heroId);
  const deck = deckFor(heroId, owned);
  const s: any = {
    heroId, enemyHeroId, opponent: 'Bot',
    playerHp: MAX_HP, playerArmor: 0, playerAp: AP_PER_TURN, playerPoison: 0,
    enemyHp: MAX_HP, enemyArmor: 0, enemyPoison: 0,
    deck, enemyDeck: botDeckFor(enemyHeroId, heroId, owned),
    botFirst: rnd(2) === 0, hand: deal(deck), turn: 1, log: ''
  };
  if (s.botFirst) {                       // the "start" action's opening swing
    botTurn(s, OPENING_AP);
    if (s.playerHp <= 0) return 'OPENING_KILL';
  }
  for (let t = 0; t < 80; t++) {
    if (playerTurn(s) === 'PLAYER') return 'PLAYER';
    if (s.enemyPoison > 0) { s.enemyHp = Math.max(0, s.enemyHp - s.enemyPoison); s.enemyPoison = Math.max(0, s.enemyPoison - 2); }
    if (s.enemyHp <= 0) return 'PLAYER';
    botTurn(s);
    if (s.playerPoison > 0) { s.playerHp = Math.max(0, s.playerHp - s.playerPoison); s.playerPoison = Math.max(0, s.playerPoison - 2); }
    if (s.playerHp <= 0) return 'BOT';
    s.turn++; s.playerAp = AP_PER_TURN; s.hand = deal(s.deck);
  }
  return 'TIMEOUT';
}

const N = Number(process.argv[2] ?? 8000);
function sweep(label: string, shop: boolean) {
  let w = 0, opening = 0, to = 0;
  const per: any = {}; for (const h of HEROES) per[h] = { n: 0, w: 0 };
  for (let i = 0; i < N; i++) {
    const h = HEROES[i % HEROES.length];
    const owned = shop ? Object.fromEntries((HERO_SHOP[h] || []).map((id: string) => [id, true])) : {};
    const r = duel(h, owned);
    per[h].n++;
    if (r === 'PLAYER') { w++; per[h].w++; }
    if (r === 'OPENING_KILL') opening++;
    if (r === 'TIMEOUT') to++;
  }
  const wr = w / N;
  console.log(`  ${label}`);
  console.log(`     win ${(wr*100).toFixed(1)}%   house ${((1 - wr*1.9)*100).toFixed(1)}%   ` +
              `lost before moving ${(opening/N*100).toFixed(1)}%   timeouts ${to}`);
  console.log(`     ${HEROES.map(h => `${h.split('-')[0]}:${(per[h].w/per[h].n*100).toFixed(0)}%`).join(' ')}`);
}

console.log(`\nAetheris arena, ${N} duels per population.`);
console.log('A win pays 1.9x, so the house breaks even at a 52.6% player win rate.\n');
sweep('players without shop skills', false);
sweep('players with both shop skills', true);
