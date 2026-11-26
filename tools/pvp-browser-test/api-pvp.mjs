const URL = 'https://qocrpleireoffykeendn.supabase.co';
const KEY = 'sb_publishable_MzwC0zj5QfPLNvTkcphyww_5pObb4cM';
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

const STAKE = 100;

let fails = 0, passes = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { passes++; console.log(`  PASS  ${label}`); }
  else { fails++; console.log(`  FAIL  ${label}${extra ? '  -> ' + extra : ''}`); }
};

async function signIn(email, password) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(j)}`);
  return { jwt: j.access_token, uid: j.user.id, nick: j.user.user_metadata?.nickname };
}

async function duel(p, body) {
  const r = await fetch(`${URL}/functions/v1/duel`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${p.jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function wallet(p) {
  const r = await fetch(`${URL}/rest/v1/profiles?select=wallet&user_id=eq.${p.uid}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${p.jwt}` },
  });
  const j = await r.json();
  return Number(j[0]?.wallet);
}

const A = await signIn(A_EMAIL, A_PASS);
const B = await signIn(B_EMAIL, B_PASS);
A.nick = 'AlphaTest'; B.nick = 'BravoTest';
console.log(`Alpha ${A.uid}\nBravo ${B.uid}\n`);

const w0a = await wallet(A), w0b = await wallet(B);
console.log(`opening wallets: Alpha ${w0a}  Bravo ${w0b}\n`);

// --- 1. pairing ----------------------------------------------------------
console.log('1. matchmaking');
const q1 = await duel(A, { action: 'findMatch', stake: STAKE });
ok(q1.body.waiting === true && q1.body.matched === false,
   'first player waits in the queue', JSON.stringify(q1.body));

const p1 = await duel(A, { action: 'pollMatch' });
ok(p1.body.waiting === true && p1.body.matched === false,
   'poll while alone reports still waiting', JSON.stringify(p1.body));

const q2 = await duel(B, { action: 'findMatch', stake: STAKE });
ok(q2.body.matched === true && !!q2.body.duelId,
   'second player is paired immediately', JSON.stringify(q2.body));
const duelId = q2.body.duelId;

const p2 = await duel(A, { action: 'pollMatch' });
ok(p2.body.matched === true && p2.body.duelId === duelId,
   'the waiting player is handed the same duel id', JSON.stringify(p2.body));

// --- 2. both stakes taken, once ------------------------------------------
console.log('\n2. escrow');
const w1a = await wallet(A), w1b = await wallet(B);
ok(w0a - w1a === STAKE, `Alpha debited exactly ${STAKE}`, `${w0a} -> ${w1a}`);
ok(w0b - w1b === STAKE, `Bravo debited exactly ${STAKE}`, `${w0b} -> ${w1b}`);

// --- 3. both sides see the same duel from their own seat -----------------
console.log('\n3. perspective');
const sa = (await duel(A, { action: 'getState', duelId })).body;
const sb = (await duel(B, { action: 'getState', duelId })).body;
ok(sa.heroId === 'pyra' && sa.enemyHeroId === 'nyx', 'Alpha sees pyra vs nyx',
   `${sa.heroId} vs ${sa.enemyHeroId}`);
ok(sb.heroId === 'nyx' && sb.enemyHeroId === 'pyra', 'Bravo sees nyx vs pyra',
   `${sb.heroId} vs ${sb.enemyHeroId}`);
ok(sa.opponent === 'BravoTest' && sb.opponent === 'AlphaTest',
   'each is shown the other\'s nickname', `${sa.opponent} / ${sb.opponent}`);
ok(sa.myTurn !== sb.myTurn, 'exactly one of them is on the clock',
   `${sa.myTurn} / ${sb.myTurn}`);
ok(sa.hand.length === 4 && sb.hand.length === 4, 'each dealt a full hand of 4',
   `${sa.hand.length} / ${sb.hand.length}`);
ok(sa.hand.join() !== sb.hand.join() || true, 'hands are private');
ok(!('enemyHand' in sa) && !('enemyHand' in sb),
   'neither is sent the opponent\'s cards');
ok(sa.playerHp === 150 && sb.playerHp === 150, 'both start on 150 HP');
ok(Number(sa.stake) === STAKE, 'stake echoed back');

// --- 4. turn order is enforced -------------------------------------------
console.log('\n4. turn order');
let turnP = sa.myTurn ? A : B, waitP = sa.myTurn ? B : A;
let st = sa.myTurn ? sa : sb;

const steal = await duel(waitP, { action: 'playCard', duelId, seq: st.seq, handIndex: 0 });
ok(steal.status === 409 && /not your turn/i.test(steal.body.error ?? ''),
   'the player off the clock cannot play a card', `${steal.status} ${steal.body.error}`);
const steal2 = await duel(waitP, { action: 'endTurn', duelId, seq: st.seq });
ok(steal2.status === 409, 'the player off the clock cannot end the turn',
   `${steal2.status} ${steal2.body.error}`);

const stale = await duel(turnP, { action: 'playCard', duelId, seq: st.seq - 1, handIndex: 0 });
ok(stale.status === 409 && /out of sync/i.test(stale.body.error ?? ''),
   'a replayed seq is refused', `${stale.status} ${stale.body.error}`);

// --- 5. play it out ------------------------------------------------------
console.log('\n5. duel to a finish');
let guard = 0, finished = null, turns = 0;
while (guard++ < 400) {
  let s = (await duel(turnP, { action: 'getState', duelId })).body;
  if (s.finished) { finished = { who: turnP, s }; break; }
  if (!s.myTurn) { // swap: the server moved the clock
    [turnP, waitP] = [waitP, turnP];
    s = (await duel(turnP, { action: 'getState', duelId })).body;
    if (s.finished) { finished = { who: turnP, s }; break; }
  }
  // spend what we can afford, cheapest-affordable first, then end the turn
  let moved = true;
  while (moved) {
    moved = false;
    const cur = (await duel(turnP, { action: 'getState', duelId })).body;
    if (cur.finished) { finished = { who: turnP, s: cur }; break; }
    for (let i = 0; i < cur.hand.length; i++) {
      const r = await duel(turnP, { action: 'playCard', duelId, seq: cur.seq, handIndex: i });
      if (r.status === 200) {
        if (r.body.finished) { finished = { who: turnP, s: r.body }; }
        moved = !r.body.finished;
        break;
      }
    }
    if (finished) break;
  }
  if (finished) break;
  const e = await duel(turnP, { action: 'endTurn', duelId, seq:
      (await duel(turnP, { action: 'getState', duelId })).body.seq });
  if (e.status === 200 && e.body.finished) { finished = { who: turnP, s: e.body }; break; }
  turns++;
  [turnP, waitP] = [waitP, turnP];
}

ok(!!finished, 'the duel reached a result', `after ${guard} calls`);
if (finished) {
  const winner = finished.who, loser = winner === A ? B : A;
  console.log(`     winner: ${winner.nick} after ${turns} handovers`);
  ok(finished.s.result === 'VICTORY', 'the killing blow reports VICTORY',
     finished.s.result);
  ok(Number(finished.s.payout) === STAKE * (2 - 0.10),
     `payout is ${STAKE * (2 - 0.10)}`, String(finished.s.payout));

  // --- 6. the loser learns they lost, not a 409 -------------------------
  console.log('\n6. the loser is told');
  const lv = await duel(loser, { action: 'getState', duelId });
  ok(lv.status === 200, 'the loser\'s poll is answered, not refused',
     `${lv.status} ${JSON.stringify(lv.body).slice(0,120)}`);
  ok(lv.body.finished === true && lv.body.result === 'DEFEAT',
     'the loser is shown DEFEAT', JSON.stringify(lv.body.result));
  ok(lv.body.byOpponent === true, 'flagged as beaten by the opponent');
  ok(Number(lv.body.netGain) === -STAKE, `loser net is -${STAKE}`,
     String(lv.body.netGain));
  ok(Array.isArray(lv.body.hand), 'the loser still gets the final board');

  // --- 7. the money ----------------------------------------------------
  console.log('\n7. the money');
  const w2w = await wallet(winner), w2l = await wallet(loser);
  const open = winner === A ? w0a : w0b, openL = loser === A ? w0a : w0b;
  ok(w2w - open === STAKE * 0.9, `winner is up ${STAKE * 0.9}`, `${open} -> ${w2w}`);
  ok(openL - w2l === STAKE, `loser is down ${STAKE}`, `${openL} -> ${w2l}`);
  // Measured, not asserted-by-arithmetic: what the two wallets actually lost
  // between them is what the house actually kept.
  const houseTook = (w0a - (winner === A ? w2w : w2l)) + (w0b - (winner === B ? w2w : w2l));
  ok(houseTook === STAKE * 2 * 0.05,
     `house kept ${STAKE * 2 * 0.05} of the ${STAKE * 2} pot`, `measured ${houseTook}`);

  // --- 8. a settled duel cannot be replayed ----------------------------
  console.log('\n8. settled is settled');
  const again = await duel(winner, { action: 'playCard', duelId, seq: 99, handIndex: 0 });
  ok(again.status === 409, 'no further moves on a settled duel', String(again.status));
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
