#!/usr/bin/env node
// Tests the QR Ph re-issuing code that ships inside index.html.
//
// Why this exists: a top-up QR is rebuilt in the browser with the player's
// amount and pay code inside it. If that rebuild ever corrupted the merchant
// account field, a player's money would land in someone else's wallet, and
// nothing else in the app would notice. So the destination is asserted
// byte-identical on every case here.
//
// The code is read out of index.html rather than duplicated, so this tests what
// actually ships. Every extraction step fails loudly: an earlier tool in this
// repo sliced on a marker that had been deleted and still reported success.
//
//   node tools/qr-check/check-qrph.mjs
//
// The fixtures are synthetic codes with fake merchant details. They have the
// same structure and institution codes as real GCash and Maya personal QRs, so
// they exercise the same paths without putting anyone's name or phone number
// into the repository.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(here, '../../index.html');

const START = '        // CRC-16/CCITT-FALSE, which is what EMVCo tag 63 carries.';
const END = '        // Validated on the way out, so a payload that got corrupted in storage';
const NEEDED = ['function qrphCrc', 'function qrphParse', 'function qrphTlv',
                'function qrphValid', 'function qrphWithAmount'];

function loadFromIndex() {
  const html = readFileSync(INDEX, 'utf8');
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a < 0) throw new Error(`start marker not found in ${INDEX}. Did the QR code block move or get reworded?`);
  if (b < 0) throw new Error(`end marker not found in ${INDEX}. Did the QR code block move or get reworded?`);
  if (b <= a) throw new Error('markers found but out of order; the slice would be nonsense');

  const src = html.slice(a, b);
  for (const n of NEEDED) {
    if (!src.includes(n)) throw new Error(`extracted slice is missing ${n}; refusing to test a partial copy`);
  }
  const ctx = { console };
  vm.createContext(ctx);
  new vm.Script(src).runInContext(ctx);
  const api = new vm.Script('({ qrphCrc, qrphParse, qrphValid, qrphWithAmount })').runInContext(ctx);
  for (const k of Object.keys(api)) {
    if (typeof api[k] !== 'function') throw new Error(`${k} did not come out of index.html as a function`);
  }
  return { api, lines: src.split('\n').length };
}

// A deliberately different CRC-16/CCITT-FALSE: table-driven, so a bug in the
// shipped bitwise version cannot hide behind an identical bug here.
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
    t[i] = c;
  }
  return t;
})();
function crcIndependent(s) {
  let crc = 0xFFFF;
  for (let i = 0; i < s.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >> 8) ^ s.charCodeAt(i)) & 0xFF]) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const FIXTURES = {
  gcashLike: '00020101021127830012com.p2pqrpay0111GXCHPHM2XXX02089999999903151234567890123450417AAAAAAAAAAAAAAAAA5204601653036085802PH5916TE*T ME**HANT A.6006MANILA610410006304B9A4',
  mayaLike: '00020101021127780012com.p2pqrpay0111PAPHPHM1XXX02089999999904126390000000000515+63-900-00000005204601653036085802PH5915TEST MERCHANT B6004CEBU6304AFE1',
};

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => {
  if (c) { pass++; }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
};

const { api, lines } = loadFromIndex();
const { qrphCrc, qrphParse, qrphValid, qrphWithAmount } = api;
console.log(`testing ${lines} lines lifted out of index.html\n`);

// --- the two CRC implementations must agree, on the fixtures and on noise ---
const crcSamples = [...Object.values(FIXTURES).map((f) => f.slice(0, -4)),
                    '', 'A', '0002010102115802PH', 'x'.repeat(300),
                    ...Array.from({ length: 50 }, () =>
                      Array.from({ length: 1 + Math.floor(Math.random() * 120) },
                        () => String.fromCharCode(32 + Math.floor(Math.random() * 95))).join(''))];
let crcDiff = 0;
for (const s of crcSamples) if (qrphCrc(s) !== crcIndependent(s)) crcDiff++;
ok(crcDiff === 0, `CRC agrees with an independent implementation over ${crcSamples.length} samples`,
   crcDiff + ' differed');

// --- the fixtures must be recognised ---
for (const [name, p] of Object.entries(FIXTURES)) {
  ok(qrphValid(p), `${name}: recognised as a valid QR Ph code`);
}

// --- things it must refuse rather than guess at ---
const mustRefuse = [
  ['a plain URL QR', 'https://example.com/pay/123', 500],
  ['a wifi QR', 'WIFI:S:somenet;T:WPA;P:hunter2;;', 500],
  ['a tampered CRC', FIXTURES.gcashLike.slice(0, -1) + 'X', 500],
  ['a truncated payload', FIXTURES.gcashLike.slice(0, 60), 500],
  ['an empty string', '', 500],
  ['a non-string', null, 500],
  ['a length field that is not digits', '00020101021X5802PH6304ABCD', 500],
  ['a length running past the end', '0099' + 'A'.repeat(10) + '6304ABCD', 500],
  ['a zero amount', FIXTURES.gcashLike, 0],
  ['a negative amount', FIXTURES.gcashLike, -500],
  ['a NaN amount', FIXTURES.gcashLike, NaN],
  ['an Infinity amount', FIXTURES.gcashLike, Infinity],
  ['an absurd amount', FIXTURES.gcashLike, 1e9],
  ['an amount as a non-number', FIXTURES.gcashLike, 'five hundred'],
];
for (const [label, payload, amt] of mustRefuse) {
  ok(qrphWithAmount(payload, amt, 'AET-TEST') === null, `refuses ${label}`);
}

// a code in another currency must never be rewritten as if it were pesos
const usd = (() => {
  const b = FIXTURES.gcashLike.replace('5303608', '5303840');
  return b.slice(0, -4) + qrphCrc(b.slice(0, -4));
})();
ok(qrphValid(usd) === false, 'a non-peso code is not considered valid');
ok(qrphWithAmount(usd, 500, 'AET-TEST') === null, 'refuses a non-peso code');

// --- the rewrite, over a spread of amounts and codes ---
const AMOUNTS = [[50, '50.00'], [1, '1.00'], [99.99, '99.99'], [100, '100.00'],
                 [500.5, '500.50'], [1234.567, '1234.57'], [999999.99, '999999.99'],
                 [0.01, '0.01']];
for (const [name, srcPayload] of Object.entries(FIXTURES)) {
  const srcFields = qrphParse(srcPayload);
  const srcGet = (t) => (srcFields.find((x) => x.tag === t) || {}).value;

  for (const [amt, want] of AMOUNTS) {
    for (const code of ['AET-X9K2', '', 'AET-ZZZZ']) {
      for (const flag of [true, false]) {
        const out = qrphWithAmount(srcPayload, amt, code, flag);
        const tag = `${name} ₱${amt} "${code}" flag=${flag}`;
        if (!out) { ok(false, `${tag}: produced a payload`); continue; }

        const f = qrphParse(out);
        if (!f) { ok(false, `${tag}: the result parses`); continue; }
        const get = (t) => (f.find((x) => x.tag === t) || {}).value;

        // THE one that matters: where the money goes must not change.
        ok(get('27') === srcGet('27'), `${tag}: destination account byte-identical`);
        ok(get('59') === srcGet('59'), `${tag}: merchant name unchanged`);
        ok(get('60') === srcGet('60'), `${tag}: merchant city unchanged`);
        ok(get('52') === srcGet('52'), `${tag}: merchant category unchanged`);
        ok(get('53') === '608', `${tag}: still pesos`);
        ok(get('58') === srcGet('58'), `${tag}: country unchanged`);

        ok(get('54') === want, `${tag}: amount encoded as ${want}`, get('54'));
        ok(get('01') === (flag ? '12' : '11'), `${tag}: point-of-initiation flag`, get('01'));

        // checked against the independent CRC, not the shipped one
        ok(crcIndependent(out.slice(0, -4)) === out.slice(-4), `${tag}: CRC correct`);
        ok(qrphValid(out), `${tag}: the result validates as QR Ph`);

        const sub = qrphParse(get('62') || '') || [];
        const refLabel = (sub.find((x) => x.tag === '05') || {}).value;
        ok(code ? refLabel === code : refLabel === undefined,
           `${tag}: reference label`, String(refLabel));

        const tags = f.map((x) => x.tag);
        ok(tags.join() === [...tags].sort().join(), `${tag}: tags ascending`, tags.join());
        ok(new Set(tags).size === tags.length, `${tag}: no duplicated tags`, tags.join());
      }
    }
  }
}

// --- rebuilding an already-rebuilt code must not pile up fields ---
let chained = qrphWithAmount(FIXTURES.gcashLike, 100, 'AET-AAAA');
for (const [amt, code] of [[200, 'AET-BBBB'], [300, 'AET-CCCC'], [400, 'AET-DDDD']]) {
  chained = qrphWithAmount(chained, amt, code);
}
const cf = qrphParse(chained) || [];
const cget = (t) => (cf.find((x) => x.tag === t) || {}).value;
ok(cf.filter((x) => x.tag === '54').length === 1, 're-issuing repeatedly leaves one amount field');
ok(cget('54') === '400.00', 'and it is the latest amount', cget('54'));
ok((qrphParse(cget('62') || '') || []).filter((x) => x.tag === '05').length === 1,
   'and one reference label');
ok(cget('27') === (qrphParse(FIXTURES.gcashLike).find((x) => x.tag === '27') || {}).value,
   'and the destination survived four rewrites');

// --- an over-long reference must not silently corrupt the payload ---
const longRef = qrphWithAmount(FIXTURES.gcashLike, 100, 'A'.repeat(200));
ok(longRef === null || qrphValid(longRef), 'an over-long reference gives null or a valid code',
   String(longRef));

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
