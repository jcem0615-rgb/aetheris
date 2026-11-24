// Rewrites the 44 base-deck cards in index.html from the duel function's
// CARD_TABLE, so the page always displays the numbers the server applies.
// Shop cards are left alone. Run check-cards.mjs afterwards.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FN = resolve(root, 'supabase/functions/duel/index.ts');
const PAGE = resolve(root, 'index.html');

const server = {};
for (const row of readFileSync(FN, 'utf8').match(/const CARD_TABLE = "([^"]+)"/s)[1].split('|')) {
  const p = row.split(',');
  server[p[0]] = { ap: +p[1], damage: +p[2], armor: +p[3], heal: +p[4], poison: +p[5], name: p[6] };
}

// Flavour words per hero, so regenerated text still reads like the hero.
const FLAV = {
  pyra:     { el: 'Fire',       dot: 'Burn stacks' },
  sylph:    { el: 'Wind',       dot: 'Poison' },
  valen:    { el: 'Steel',      dot: null },
  nyx:      { el: 'Shadow',     dot: 'Poison' },
  storm:    { el: 'Lightning',  dot: null },
  titan:    { el: 'Earth',      dot: null },
  chrono:   { el: 'Temporal',   dot: null },
  valkyrie: { el: 'Holy',       dot: null },
  void:     { el: 'Necrotic',   dot: 'Plague' },
  berserk:  { el: 'Brutal',     dot: null },
  astral:   { el: 'Cosmic',     dot: null },
};

function describe(id, c) {
  const [pre, slot] = [id.replace(/-\d$/, ''), id.slice(-1)];
  const f = FLAV[pre];
  if (slot === '1') return `Deal ${c.damage} ${f.el} damage.`;
  if (slot === '2') return `Gain ${c.armor} Armor block.`;
  if (slot === '3') return c.poison
    ? `Deal ${c.damage} ${f.el} damage & apply ${c.poison} ${f.dot}.`
    : `Deal ${c.damage} ${f.el} damage.`;
  // slot 4 always attacks now; it used to be a pure heal or pure shield
  if (c.heal)  return `Deal ${c.damage} ${f.el} damage & restore ${c.heal} HP.`;
  if (c.armor) return `Deal ${c.damage} ${f.el} damage & gain ${c.armor} Armor block.`;
  return `Deal ${c.damage} ${f.el} damage.`;
}

let page = readFileSync(PAGE, 'utf8');
let changed = 0;
for (const id of Object.keys(server).filter(k => !k.startsWith('shop-'))) {
  const c = server[id];
  const re = new RegExp(`\\{[^{}]*\\bid: '${id}'[^{}]*\\}`);
  const m = page.match(re);
  if (!m) { console.error('could not find ' + id + ' in index.html'); process.exit(1); }
  const keep = (k) => { const r = m[0].match(new RegExp(`\\b${k}: ('[^']*')`)); return r ? r[1] : null; };
  const parts = [`id: '${id}'`, `type: ${keep('type')}`, `name: '${c.name}'`, `ap: ${c.ap}`, `color: ${keep('color')}`];
  for (const k of ['damage', 'armor', 'heal', 'poison']) if (c[k]) parts.push(`${k}: ${c[k]}`);
  parts.push(`desc: '${describe(id, c)}'`);
  page = page.replace(re, `{ ${parts.join(', ')} }`);
  changed++;
}

// "true damage" normally means damage that ignores armour. Every hit in this
// engine goes through hit(), which subtracts armour first, so the phrase was
// wrong on every card that used it.
const trueDmg = (page.match(/true damage/g) || []).length;
page = page.replace(/ true damage/g, ' damage');

writeFileSync(PAGE, page);
console.log(`rewrote ${changed} base cards; corrected "true damage" on ${trueDmg} card texts`);
