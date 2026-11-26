// The card numbers live twice: the duel function applies them, index.html
// displays them. If they disagree, the arena silently lies to players about
// what they are buying and playing. This fails loudly on any drift.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fn = readFileSync(resolve(root, 'supabase/functions/duel/index.ts'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');

// server side: id,ap,damage,armor,heal,poison,NAME
const server = {};
for (const row of fn.match(/const CARD_TABLE = "([^"]+)"/s)[1].split('|')) {
  const p = row.split(',');
  server[p[0]] = { ap: +p[1], damage: +p[2], armor: +p[3], heal: +p[4], poison: +p[5], name: p[6] };
}

// client side: object literals carrying an id plus any of the effect fields
const client = {};
for (const m of html.matchAll(/\{[^{}]*\bid:\s*'([a-z0-9-]+)'[^{}]*\}/g)) {
  const body = m[0];
  if (!/\bap:\s*\d/.test(body)) continue;            // not a card
  const num = (k) => { const r = body.match(new RegExp('\\b' + k + ":\\s*(\\d+)")); return r ? +r[1] : 0; };
  const nm = body.match(/name:\s*'([^']*)'/);
  client[m[1]] = { ap: num('ap'), damage: num('damage'), armor: num('armor'),
                   heal: num('heal'), poison: num('poison'), name: nm ? nm[1] : '' };
}

const FIELDS = ['ap', 'damage', 'armor', 'heal', 'poison'];
const problems = [];
for (const id of Object.keys(server)) {
  const a = server[id], b = client[id];
  if (!b) { problems.push(`${id}: in the duel function, missing from index.html`); continue; }
  for (const f of FIELDS) {
    if (a[f] !== b[f]) problems.push(`${id} ${f}: function says ${a[f]}, page says ${b[f]}`);
  }
  if (a.name !== b.name) problems.push(`${id} name: function says "${a.name}", page says "${b.name}"`);
}
for (const id of Object.keys(client)) {
  if (!server[id]) problems.push(`${id}: in index.html, missing from the duel function`);
}

// The platform fee is quoted to the player twice on the page, and it is the
// price of playing. If it drifts from the engine the arena misstates what it
// charges - a player told 5% while 10% is taken has been overcharged, which
// matters more than any card number being wrong.
const feeM = fn.match(/const PLATFORM_FEE = ([0-9.]+)/);
if (!feeM) {
  problems.push('PLATFORM_FEE not found in the duel function');
} else {
  const pct = Math.round(Number(feeM[1]) * 100);
  const quoted = [...html.matchAll(/(\d+)% platform fee/g)].map((m) => Number(m[1]));
  if (!quoted.length) {
    problems.push('the page never quotes a platform fee to the player');
  }
  for (const q of quoted) {
    if (q !== pct) problems.push(`platform fee: function takes ${pct}%, page tells the player ${q}%`);
  }
}

console.log(`checked ${Object.keys(server).length} cards in the duel function against ${Object.keys(client).length} in index.html`);
if (problems.length) {
  console.log('\nMISMATCHES:');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('both copies agree');
