// Top-up and withdrawal, end to end, against the live site.
//
// These are the two paths where real money enters and leaves, so this covers
// the security properties as well as the happy path: a player cannot approve
// their own request nor flip its status directly, the same request cannot be
// approved twice, and an over-balance withdrawal moves nothing AND does not
// leave the request reading approved.
//
// That last one was a real bug. The handler claims a request by flipping it
// out of pending BEFORE moving the wallet; when the wallet move failed the row
// stayed approved with no money behind it, so the owner history showed a
// payout that never happened. Anyone working from that list to decide what to
// send by GCash would have sent it.
//
//   export PLAYER_EMAIL=... PLAYER_PASS=... ADMIN_EMAIL=... ADMIN_PASS=...
//   node tools/pvp-browser-test/money-test.mjs
//
// The admin account must be in the admins table. Both accounts are real and
// this moves real balances - use test accounts and delete them afterwards.

const URL = 'https://qocrpleireoffykeendn.supabase.co';
const KEY = 'sb_publishable_MzwC0zj5QfPLNvTkcphyww_5pObb4cM';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (e ? '  -> ' + e : '')); }
};

async function signIn(email, password) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(email + ': ' + JSON.stringify(j).slice(0, 160));
  return { jwt: j.access_token, uid: j.user.id, email };
}
const rest = async (p, path, init = {}) => {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${p.jwt}`, 'Content-Type': 'application/json',
               Prefer: 'return=representation', ...(init.headers || {}) },
  });
  const t = await r.text();
  let body; try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body };
};
const admin = async (p, body) => {
  const r = await fetch(`${URL}/functions/v1/admin-actions`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${p.jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const wallet = async (p) => {
  const r = await rest(p, `profiles?select=wallet&user_id=eq.${p.uid}`);
  return Number(r.body[0]?.wallet);
};

const PLAYER = await signIn(process.env.PLAYER_EMAIL, process.env.PLAYER_PASS);
const OWNER  = await signIn(process.env.ADMIN_EMAIL,  process.env.ADMIN_PASS);
const today = new Date().toISOString().split('T')[0];

console.log('start wallet: ₱' + await wallet(PLAYER) + '\n');

// ---------------- TOP-UP ----------------
console.log('TOP-UP');
const w0 = await wallet(PLAYER);

const tu = await rest(PLAYER, 'topup_requests', {
  method: 'POST',
  body: JSON.stringify([{ email: PLAYER.email, nickname: 'MoneyTest', amount: 500,
    ref: 'TEST-REF-1', method: 'gcash', status: 'pending', date: today, user_id: PLAYER.uid }]),
});
ok(tu.status === 201 && tu.body[0]?.id, 'player can submit a top-up request',
   tu.status + ' ' + JSON.stringify(tu.body).slice(0, 120));
const tuId = tu.body[0]?.id;

// a player must not be able to approve their own
const selfApprove = await admin(PLAYER, { action: 'approveTopup', id: tuId });
ok(selfApprove.status === 403, 'a player cannot approve their own top-up',
   selfApprove.status + ' ' + JSON.stringify(selfApprove.body));

// and must not be able to flip the row directly
const selfPatch = await rest(PLAYER, `topup_requests?id=eq.${tuId}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'approved' }),
});
const stillPending = await rest(OWNER, `topup_requests?select=status&id=eq.${tuId}`);
ok(stillPending.body[0]?.status === 'pending',
   'a player cannot mark their own top-up approved',
   `patch ${selfPatch.status}, status now ${stillPending.body[0]?.status}`);

const approve = await admin(OWNER, { action: 'approveTopup', id: tuId });
ok(approve.status === 200 && approve.body.ok, 'the owner approves it',
   approve.status + ' ' + JSON.stringify(approve.body));

const w1 = await wallet(PLAYER);
ok(w1 - w0 === 500, 'the wallet is credited ₱500', `${w0} -> ${w1}`);

const led = await rest(OWNER, `wallet_ledger?select=type,amount,reason&user_id=eq.${PLAYER.uid}&order=id.desc&limit=1`);
ok(led.body[0]?.type === 'CREDIT' && Number(led.body[0]?.amount) === 500
   && /Top-Up approved/.test(led.body[0]?.reason || ''),
   'and a matching ledger row is written', JSON.stringify(led.body[0]));

const again = await admin(OWNER, { action: 'approveTopup', id: tuId });
ok(again.status === 409, 'approving the same top-up twice is refused', String(again.status));
const w1b = await wallet(PLAYER);
ok(w1b === w1, 'and the second attempt credited nothing', `${w1} -> ${w1b}`);

// ---------------- WITHDRAWAL ----------------
console.log('\nWITHDRAWAL');
const wd = await rest(PLAYER, 'withdrawal_requests', {
  method: 'POST',
  body: JSON.stringify([{ email: PLAYER.email, nickname: 'MoneyTest', amount: 300,
    method: 'gcash', account: '09181110088', name: 'Money Test',
    status: 'pending', date: today, user_id: PLAYER.uid }]),
});
ok(wd.status === 201 && wd.body[0]?.id, 'player can submit a withdrawal request',
   wd.status + ' ' + JSON.stringify(wd.body).slice(0, 120));
const wdId = wd.body[0]?.id;

const wApprove = await admin(OWNER, { action: 'approveWithdrawal', id: wdId });
ok(wApprove.status === 200 && wApprove.body.ok, 'the owner approves it',
   wApprove.status + ' ' + JSON.stringify(wApprove.body));

const w2 = await wallet(PLAYER);
ok(w1 - w2 === 300, 'the wallet is debited ₱300', `${w1} -> ${w2}`);

const led2 = await rest(OWNER, `wallet_ledger?select=type,amount,reason&user_id=eq.${PLAYER.uid}&order=id.desc&limit=1`);
ok(led2.body[0]?.type === 'DEBIT' && Number(led2.body[0]?.amount) === 300
   && /Withdrawal approved/.test(led2.body[0]?.reason || ''),
   'and a matching ledger row is written', JSON.stringify(led2.body[0]));

// ---------------- OVERDRAW ----------------
// The client checks the balance before submitting, but that check lives in the
// browser. This submits past it, the way a modified client would.
console.log('\nOVERDRAW (the client-side balance check bypassed)');
const bal = await wallet(PLAYER);
const over = await rest(PLAYER, 'withdrawal_requests', {
  method: 'POST',
  body: JSON.stringify([{ email: PLAYER.email, nickname: 'MoneyTest', amount: bal + 5000,
    method: 'gcash', account: '09181110088', name: 'Money Test',
    status: 'pending', date: today, user_id: PLAYER.uid }]),
});
const overId = over.body[0]?.id;
ok(over.status === 201, 'an over-balance request can be submitted (client check only)',
   String(over.status));

const overApprove = await admin(OWNER, { action: 'approveWithdrawal', id: overId });
const w3 = await wallet(PLAYER);
ok(w3 === bal, 'approving it does NOT move the wallet', `${bal} -> ${w3}`);
ok(overApprove.status >= 400, 'and the owner is told it failed',
   overApprove.status + ' ' + JSON.stringify(overApprove.body).slice(0, 140));

const overRow = await rest(OWNER, `withdrawal_requests?select=status,decided_at&id=eq.${overId}`);
// The real test: a request that was NOT paid must not read 'approved'. The
// owner works from this list to decide what to send by GCash.
ok(overRow.body[0]?.status === 'pending',
   'the unpaid request goes BACK to pending, not left reading approved',
   'status ' + overRow.body[0]?.status);
ok(!overRow.body[0]?.decided_at,
   'and it carries no decision timestamp', String(overRow.body[0]?.decided_at));
ok(overApprove.body?.requestReturnedToQueue === true,
   'the owner is told it was returned to the queue',
   JSON.stringify(overApprove.body));

// it must still be approvable once the player has the balance
const topUp2 = await rest(PLAYER, 'topup_requests', {
  method: 'POST',
  body: JSON.stringify([{ email: PLAYER.email, nickname: 'MoneyTest', amount: 6000,
    ref: 'TEST-REF-2', method: 'gcash', status: 'pending', date: today, user_id: PLAYER.uid }]),
});
await admin(OWNER, { action: 'approveTopup', id: topUp2.body[0].id });
const retry = await admin(OWNER, { action: 'approveWithdrawal', id: overId });
ok(retry.status === 200, 'and once funded, the same request approves cleanly',
   retry.status + ' ' + JSON.stringify(retry.body).slice(0, 100));

// ---------------- REJECT ----------------
console.log('\nREJECT');
const rj = await rest(PLAYER, 'withdrawal_requests', {
  method: 'POST',
  body: JSON.stringify([{ email: PLAYER.email, nickname: 'MoneyTest', amount: 100,
    method: 'gcash', account: '09181110088', name: 'Money Test',
    status: 'pending', date: today, user_id: PLAYER.uid }]),
});
const rjId = rj.body[0]?.id;
const before = await wallet(PLAYER);
const rejected = await admin(OWNER, { action: 'rejectWithdrawal', id: rjId });
const after = await wallet(PLAYER);
ok(rejected.status === 200, 'the owner can reject a withdrawal', String(rejected.status));
ok(after === before, 'rejecting moves no money', `${before} -> ${after}`);
const rjRow = await rest(OWNER, `withdrawal_requests?select=status&id=eq.${rjId}`);
ok(rjRow.body[0]?.status === 'rejected', 'and the request is marked rejected',
   String(rjRow.body[0]?.status));

console.log(`\nfinal wallet: ₱${await wallet(PLAYER)}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
