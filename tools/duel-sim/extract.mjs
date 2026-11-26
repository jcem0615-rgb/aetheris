// Pulls the pure game logic out of supabase/functions/duel/index.ts into a
// loadable module, so the simulator measures the code that is actually
// deployed rather than a copy that can drift from it.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../../supabase/functions/duel/index.ts'), 'utf8');

// indexOf returns -1 for a marker that is not there, and slice(start, -1)
// quietly returns almost the whole file instead of failing. That is how this
// script carried on reporting success after the house bot was removed and the
// marker it used (`function publicState`) went with it, writing a module that
// could not even load. Both ends are checked now.
const START = 'const PLATFORM_FEE';
const END = '// ---------------------------------------------------------------- PvP ----';
const a = src.indexOf(START), b = src.indexOf(END);
if (a < 0 || b < 0 || b <= a) {
  console.error(`extract.mjs: could not find ${a < 0 ? START : END} in the duel function.`);
  console.error('The engine was restructured; update these markers rather than trusting the slice.');
  process.exit(1);
}

const slice = src.slice(a, b)
  .replace(/const cors = \{[\s\S]*?\};\n/, '')
  .replace(/const json = \(b: unknown[\s\S]*?\n\n/, '')
  .replace(/const db = \(\).*\n/, '');

writeFileSync(resolve(here, 'botlogic.ts'), slice + `
export { PLATFORM_FEE,
         CARDS, HERO_BASE, HERO_SHOP, HERO_LADDER, MAX_HP, AP_PER_TURN, HAND_SIZE,
         deal, hit, deckFor, rnd, powerOf, toleranceFor };
`);
console.log('botlogic.ts written from the deployed function source');
