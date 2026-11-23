// Pulls the pure game logic out of supabase/functions/duel/index.ts into a
// loadable module, so the simulator measures the code that is actually
// deployed rather than a copy that can drift from it.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../../supabase/functions/duel/index.ts'), 'utf8');

const slice = src.slice(src.indexOf('const PLATFORM_FEE'), src.indexOf('function publicState'))
  .replace(/const cors = \{[\s\S]*?\};\n/, '')
  .replace(/const json = \(b: unknown[\s\S]*?\n\n/, '')
  .replace(/const db = \(\).*\n/, '');

writeFileSync(resolve(here, 'botlogic.ts'), slice + `
export { CARDS, HERO_BASE, HERO_SHOP, HERO_LADDER, MAX_HP, AP_PER_TURN, HAND_SIZE, OPENING_AP,
         deal, hit, deckFor, matchOpponentHero, botDeckFor, botTurn, rnd, pick };
export type { State };
`);
console.log('botlogic.ts written from the deployed function source');
