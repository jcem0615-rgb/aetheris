// Drives the real top-up modal on the live site: types into the real amount
// input, fires the real input event, waits out the real debounce, then reads
// whatever ended up in the QR box and decodes it.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
const { chromium } = createRequire(process.env.PLAYWRIGHT_FROM || '/opt/node-tools/')('playwright');

const SITE = process.env.SITE || 'https://aetheris-chi-rose.vercel.app';
const OUT = process.env.QR_TEST_OUT || '/tmp/aetheris-qr-test';
mkdirSync(OUT + '/shots', { recursive: true });

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (e ? '  -> ' + e : '')); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 1100 }, deviceScaleFactor: 2 });
page.on('dialog', async (d) => await d.accept());
page.on('console', (m) => { if (m.type() === 'error') console.log('    [console error] ' + m.text().slice(0, 140)); });

await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);          // let merchant_config arrive

// Open the real modal through the app's own entry point.
await page.evaluate(() => window.openModal('topup'));
await page.waitForTimeout(600);

const modalUp = await page.evaluate(() =>
  !document.getElementById('modal-topup').classList.contains('hidden'));
ok(modalUp, 'the top-up modal opens');

// the amount field must exist and come BEFORE the QR in the document
const order = await page.evaluate(() => {
  const amt = document.getElementById('topup-amount');
  const qr = document.getElementById('topup-qr-wrap');
  if (!amt || !qr) return { missing: !amt ? 'topup-amount' : 'topup-qr-wrap' };
  return { before: !!(amt.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING) };
});
ok(!order.missing, 'the amount input and QR box are both present', order.missing);
ok(order.before, 'the amount is asked for before the QR is shown');

// a fresh modal must start blank
const fresh = await page.evaluate(() => ({
  amount: document.getElementById('topup-amount').value,
  ref: document.getElementById('topup-ref').value,
  code: document.getElementById('topup-pay-code').innerText,
}));
ok(fresh.amount === '' && fresh.ref === '', 'it opens with the fields cleared',
   JSON.stringify(fresh));
ok(/^AET-[A-Z0-9]{4}$/.test(fresh.code), 'and a fresh pay code', fresh.code);

async function readQrBox() {
  return page.evaluate(() => {
    const box = document.getElementById('topup-active-qr');
    const canvas = box.querySelector('canvas');
    const img = box.querySelector('img');
    return {
      kind: canvas ? 'canvas' : (img ? 'img' : 'empty'),
      png: canvas ? canvas.toDataURL('image/png').split(',')[1] : null,
      note: (document.getElementById('topup-qr-note') || {}).innerText || '',
      code: document.getElementById('topup-pay-code').innerText,
      wrapShown: !document.getElementById('topup-qr-wrap').classList.contains('hidden'),
    };
  });
}

// Type an amount the way a player does, then let the debounce fire.
async function typeAmount(v) {
  await page.fill('#topup-amount', String(v));
  await page.waitForTimeout(900);
  return readQrBox();
}

const shots = {};

console.log('\nGCASH');
const g500 = await typeAmount(500);
ok(g500.wrapShown, 'the QR section is visible');
ok(g500.kind === 'canvas', 'a generated QR is drawn (not the plain image)', g500.kind);
ok(/500\.00/.test(g500.note) && g500.note.includes(g500.code),
   'the note states the amount and the code', g500.note);
if (g500.png) shots.gcash500 = { png: g500.png, amount: 500, code: g500.code, method: 'gcash' };
await page.screenshot({ path: OUT + '/shots/topup-gcash-500.png' });

// changing the amount must rebuild it
const g120 = await typeAmount(120.75);
ok(g120.kind === 'canvas' && /120\.75/.test(g120.note), 'changing the amount rebuilds it', g120.note);
ok(g120.png !== g500.png, 'and the picture actually changed');
if (g120.png) shots.gcash120 = { png: g120.png, amount: 120.75, code: g120.code, method: 'gcash' };

// below the minimum: fall back, do not pre-fill a figure we would reject
const g10 = await typeAmount(10);
ok(!/10\.00/.test(g10.note), 'an amount under the ₱50 minimum is not baked in', g10.note);
ok(/enter the amount/i.test(g10.note) || g10.kind === 'img',
   'and the player is told what to do instead', `${g10.kind}: ${g10.note}`);

console.log('\nMAYA');
await page.click('#btn-topup-maya');
await page.waitForTimeout(700);
const m300 = await typeAmount(300);
ok(m300.kind === 'canvas' && /300\.00/.test(m300.note), 'switching to Maya rebuilds for Maya', m300.note);
if (m300.png) shots.maya300 = { png: m300.png, amount: 300, code: m300.code, method: 'maya' };
await page.screenshot({ path: OUT + '/shots/topup-maya-300.png' });

// the code must be stable across a channel switch, or the owner cannot reconcile
ok(m300.code === g500.code, 'the pay code survives a channel switch', `${g500.code} -> ${m300.code}`);

console.log('\nREOPENING');
await page.evaluate(() => window.closeModal());
await page.waitForTimeout(300);
await page.evaluate(() => window.openModal('topup'));
await page.waitForTimeout(800);
const reopened = await page.evaluate(() => ({
  amount: document.getElementById('topup-amount').value,
  code: document.getElementById('topup-pay-code').innerText,
  kind: document.getElementById('topup-active-qr').querySelector('canvas') ? 'canvas' : 'img/none',
}));
ok(reopened.amount === '', 'reopening clears the old amount', reopened.amount);
ok(reopened.code !== g500.code, 'and issues a new pay code', `${g500.code} -> ${reopened.code}`);

writeFileSync(OUT + '/modal-shots.json', JSON.stringify(shots));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
