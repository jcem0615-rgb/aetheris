// ESM import does not follow Node's global module resolution the way require
// does, so reach the preinstalled playwright through its real path.
import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/node-tools/')('playwright');

const SITE = 'https://aetheris-chi-rose.vercel.app';
// Credentials come from the environment; nothing about these accounts is
// committed. Export them before running:
//   export PVP_A_EMAIL=... PVP_A_PASS=... PVP_B_EMAIL=... PVP_B_PASS=...
const A_EMAIL = process.env.PVP_A_EMAIL;
const A_PASS  = process.env.PVP_A_PASS;
const B_EMAIL = process.env.PVP_B_EMAIL;
const B_PASS  = process.env.PVP_B_PASS;
if (!A_EMAIL || !A_PASS || !B_EMAIL || !B_PASS) {
  console.error('Set PVP_A_EMAIL, PVP_A_PASS, PVP_B_EMAIL and PVP_B_PASS first.');
  process.exit(2);
}

const SHOTS = '/tmp/claude-0/-home-user-aetheris/dd964ee5-6c0c-5d53-9feb-799b17f1dfe8/scratchpad/pvp/shots';
let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (e ? '  -> ' + e : '')); }
};

const isHidden = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return !el || el.classList.contains('hidden');
}, sel);

async function makePlayer(browser, email, password, label) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 880 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    console.log('     [' + label + ' dialog] ' + d.message().slice(0, 160));
    await d.accept();
  });
  page.on('pageerror', (e) => console.log('     [' + label + ' JS ERROR] ' + e.message));
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-email', { state: 'attached', timeout: 30000 });
  await page.fill('#login-email', email);
  await page.fill('#login-pass', password);
  await page.click('button:has-text("Sign In")');
  await page.waitForFunction(() => {
    const a = document.getElementById('view-auth');
    const h = document.getElementById('view-hub');
    return a && h && a.classList.contains('hidden') && !h.classList.contains('hidden');
  }, { timeout: 40000 });
  return { ctx, page, dialogs, label };
}

const browser = await chromium.launch();
console.log('signing in two separate browser sessions\n');
const A = await makePlayer(browser, A_EMAIL, A_PASS, 'ALPHA');
const B = await makePlayer(browser, B_EMAIL, B_PASS, 'BRAVO');
ok(true, 'both players reached the hub');

// Read the wallet off the nav badge the player actually looks at, rather than
// internal state - it is both a truer check and the only one exposed.
const walletOf = (p) => p.page.evaluate(() => {
  const el = document.getElementById('nav-wallet');
  return el ? Number(el.innerText.replace(/[^0-9.]/g, '')) : NaN;
});
const w0a = await walletOf(A), w0b = await walletOf(B);
console.log('     wallets: Alpha P' + w0a + '  Bravo P' + w0b + '\n');

async function queueAt(p, stake) {
  await p.page.click('div[onclick*="openModal(\'bet\')"]');
  await p.page.waitForFunction(() => {
    const m = document.getElementById('modal-bet');
    return m && !m.classList.contains('hidden');
  }, { timeout: 15000 });
  const peso = '₱';
  await p.page.click('#modal-bet button:has-text("' + peso + stake + '")');
}

console.log('Alpha queues for a 100-peso ranked duel');
await queueAt(A, 100);
await A.page.waitForTimeout(3000);
const searching = await A.page.evaluate(() => {
  const m = document.getElementById('modal-matchmaking');
  const c = document.getElementById('matchmaking-countdown');
  return { open: !!m && !m.classList.contains('hidden'), text: c ? c.innerText : '' };
});
ok(searching.open, 'Alpha sees the searching dialog', JSON.stringify(searching));
console.log('     countdown reads: ' + searching.text);
await A.page.screenshot({ path: SHOTS + '/1-alpha-searching.png' });

console.log('Bravo queues at the same stake');
await queueAt(B, 100);

const arenaUp = (p) => p.page.waitForFunction(() => {
  const v = document.getElementById('view-duel-fullscreen');
  return v && !v.classList.contains('hidden');
}, { timeout: 45000 });

await arenaUp(B);
ok(true, 'Bravo is taken straight into the arena');
await arenaUp(A);
ok(true, 'Alpha is pulled in by the poll, inside the 20s window');

await A.page.screenshot({ path: SHOTS + '/2-alpha-arena.png' });
await B.page.screenshot({ path: SHOTS + '/3-bravo-arena.png' });

// Everything here comes off the rendered HUD, because the page keeps its
// duel state in a closure rather than on window.
const seat = (p) => p.page.evaluate(() => {
  const t = (id) => { const e = document.getElementById(id); return e ? e.innerText.trim() : ''; };
  const btn = document.getElementById('btn-end-turn');
  const hand = document.querySelectorAll('#shuffled-hand-container > div');
  const hp = t('fs-player-hp-text').split('/');
  return {
    opp: t('fs-enemy-name-label'),
    enemyTitle: t('fs-enemy-title'),
    hp: Number(hp[0]), maxHp: Number(hp[1]),
    enemyHp: Number(t('fs-enemy-hp-text').split('/')[0]),
    ap: Number(t('fs-player-ap')),
    hand: hand.length,
    myTurn: !!btn && !btn.disabled,
    bet: t('fullscreen-bet-badge'),
  };
});
const sa = await seat(A), sb = await seat(B);
console.log('     Alpha: vs ' + sa.enemyTitle + ' (' + sa.opp + ')  ' + sa.hp + 'HP  myTurn=' + sa.myTurn);
console.log('     Bravo: vs ' + sb.enemyTitle + ' (' + sb.opp + ')  ' + sb.hp + 'HP  myTurn=' + sb.myTurn);
ok(sa.opp.toLowerCase() === 'bravotest', 'Alpha is shown a real nickname, not a bot name', sa.opp);
ok(sb.opp.toLowerCase() === 'alphatest', 'Bravo is shown a real nickname, not a bot name', sb.opp);
ok(sa.enemyTitle !== sb.enemyTitle, 'each faces a different hero', sa.enemyTitle + ' / ' + sb.enemyTitle);
ok(sa.myTurn !== sb.myTurn, 'End Turn is live for exactly one of them');
ok(sa.hand === 4 && sb.hand === 4, 'both dealt 4 cards', sa.hand + '/' + sb.hand);
ok(sa.hp === 150 && sa.maxHp === 150, 'Alpha on 150/150 HP', sa.hp + '/' + sa.maxHp);
ok(sb.hp === 150 && sb.maxHp === 150, 'Bravo on 150/150 HP', sb.hp + '/' + sb.maxHp);
ok(/100/.test(sa.bet) && /100/.test(sb.bet), 'both see the 100 stake on the badge', sa.bet + ' / ' + sb.bet);

const waitP = sa.myTurn ? B : A;
const deadHand = await waitP.page.evaluate(() => {
  const h = document.getElementById('shuffled-hand-container');
  const l = document.getElementById('fs-battle-log');
  return { pe: h ? h.style.pointerEvents : '?', op: h ? h.style.opacity : '?',
           log: l ? l.innerText : '' };
});
ok(deadHand.pe === 'none', "the waiting player's hand is click-blocked", deadHand.pe);
ok(/Waiting for/i.test(deadHand.log), 'and the log names who it waits on', deadHand.log.slice(0, 70));

console.log('\nplaying the duel out with real clicks');
const finishedP = (p) => p.page.evaluate(() => {
  const v = document.getElementById('view-duel-fullscreen');
  return !v || v.classList.contains('hidden');
});

let rounds = 0;
let done = false;
for (let guard = 0; guard < 60 && !done; guard++) {
  for (const p of [A, B]) {
    if (await finishedP(p)) { done = true; break; }
    const mine = await p.page.evaluate(() => {
      const b = document.getElementById('btn-end-turn');
      return !!b && !b.disabled;
    });
    if (!mine) continue;

    // The page dims a card it cannot pay for with opacity-50, so the
    // affordable ones are exactly what a player would be able to click.
    //
    // The hand re-renders on every poll and goes pointer-events:none the
    // instant the turn flips, so a click can land mid-rerender on a node that
    // is already gone. A person clicks once and waits; this driver clicks far
    // faster than that, so each click is given a short timeout and a miss just
    // re-reads the board instead of failing the run.
    for (let c = 0; c < 4; c++) {
      const stillMine = await p.page.evaluate(() => {
        const b = document.getElementById('btn-end-turn');
        const h = document.getElementById('shuffled-hand-container');
        return !!b && !b.disabled && !!h && h.style.pointerEvents !== 'none';
      });
      if (!stillMine) break;
      const affordable = p.page.locator('#shuffled-hand-container > div:not(.opacity-50)');
      if (!(await affordable.count())) break;
      try {
        await affordable.first().click({ timeout: 5000 });
      } catch {
        break;
      }
      await p.page.waitForTimeout(900);
      if (await finishedP(p)) { done = true; break; }
    }
    if (done) break;

    const btn = p.page.locator('#btn-end-turn');
    if (await btn.count() && !(await btn.isDisabled())) {
      try {
        await btn.click({ timeout: 5000 });
        rounds++;
        await p.page.waitForTimeout(1500);
      } catch { /* turn flipped under us; the next pass re-reads the board */ }
    }
    if (await finishedP(p)) { done = true; break; }
  }
  await A.page.waitForTimeout(1200);
}

console.log('     ' + rounds + ' turn handovers');
await A.page.waitForTimeout(7000);
await B.page.waitForTimeout(1000);

ok((await finishedP(A)) && (await finishedP(B)), 'the arena closed on both clients');

const all = A.dialogs.concat(B.dialogs);
const vic = all.filter((m) => /VICTORY/.test(m));
const def = all.filter((m) => /DEFEAT/.test(m));
ok(vic.length === 1, 'exactly one client was told VICTORY', vic.length + ': ' + vic.join());
ok(def.length === 1, 'exactly one client was told DEFEAT', def.length + ': ' + def.join());
ok(/190\.00/.test(vic[0] || ''), 'the winner is told 190.00 was paid out', vic[0] || '(none)');
ok(/took the pot/.test(def[0] || ''), 'the loser is told the opponent took the pot', def[0] || '(none)');

const w1a = await walletOf(A), w1b = await walletOf(B);
console.log('     wallets after: Alpha P' + w1a + '  Bravo P' + w1b);
const moved = (w1a - w0a) + (w1b - w0b);
ok(moved === -10, 'the two wallets lost 10 between them (the 5% rake)', 'moved ' + moved);
ok((w1a - w0a === 90 && w1b - w0b === -100) || (w1b - w0b === 90 && w1a - w0a === -100),
   'one is +90, the other -100', (w1a - w0a) + ' / ' + (w1b - w0b));

await A.page.screenshot({ path: SHOTS + '/4-alpha-after.png' });
await B.page.screenshot({ path: SHOTS + '/5-bravo-after.png' });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);
