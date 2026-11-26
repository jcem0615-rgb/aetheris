import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.49.4";

const REGISTRATION_FEE = 50;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const db = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// A request is claimed by flipping it out of 'pending' first, which is what
// makes approving the same one twice impossible. But if the wallet move then
// fails - an over-balance withdrawal being the obvious case - the row was left
// reading 'approved' with no money behind it, and the owner's history showed a
// payout that never happened. Anyone working from that list to decide what to
// send by GCash would send it.
//
// The claim is released again on failure, putting the request back in the
// queue exactly as it was.
// deno-lint-ignore no-explicit-any
async function releaseClaim(sb: any, table: string, id: number,
    audit: (what: string, detail: string) => unknown) {
  const { error } = await sb.from(table)
    .update({ status: "pending", decided_at: null, decided_by: null })
    .eq("id", id);
  if (error) {
    // The row is now wrong and cannot be put right automatically. Say so
    // loudly rather than leaving it to be found by accident.
    await audit("Request Stuck",
      `${table} #${id} reads decided but the wallet did not move, and it could ` +
      `not be returned to pending (${error.message}). Fix this row by hand.`);
  }
  return !error;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const sb = db();
  const { data: auth } = await sb.auth.getUser(token);
  if (!auth?.user) return json({ error: "Not signed in" }, 401);

  // Admin membership is checked server-side against the admins table.
  const { data: adminRow } = await sb
    .from("admins")
    .select("user_id, email")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!adminRow) return json({ error: "Not authorised" }, 403);
  const actor = adminRow.email;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = String(body.action ?? "");
  const now = new Date().toISOString();

  const audit = (what: string, detail: string) =>
    sb.from("audit_logs").insert([{ action: what, details: detail, performed_by: actor }]);

  // ---- top-ups -------------------------------------------------------------
  if (action === "approveTopup" || action === "rejectTopup") {
    const approve = action === "approveTopup";
    const { data: row } = await sb
      .from("topup_requests")
      .select("id, user_id, email, nickname, amount, ref, status")
      .eq("id", Number(body.id))
      .maybeSingle();

    if (!row) return json({ error: "Request not found" }, 404);
    if (row.status !== "pending") return json({ error: "Already decided" }, 409);

    const { data: upd } = await sb
      .from("topup_requests")
      .update({ status: approve ? "approved" : "rejected", decided_at: now, decided_by: actor })
      .eq("id", row.id).eq("status", "pending").select("id");
    if (!upd?.length) return json({ error: "Already decided" }, 409);

    let balance = null;
    if (approve) {
      if (!row.user_id) return json({ error: "Request has no linked account" }, 400);
      const { data: bal, error } = await sb.rpc("apply_wallet_delta", {
        p_user_id: row.user_id,
        p_delta: Number(row.amount),
        p_reason: `Top-Up approved (Ref: ${row.ref})`,
        p_type: "CREDIT",
      });
      if (error) {
        const freed = await releaseClaim(sb, "topup_requests", row.id, audit);
        return json({ error: error.message, requestReturnedToQueue: freed }, 400);
      }
      balance = bal?.[0]?.post_balance;
    }

    await audit(approve ? "Top-Up Approved" : "Top-Up Rejected",
      `${row.email}: ₱${row.amount} (Ref: ${row.ref})`);
    return json({ ok: true, balance });
  }

  // ---- withdrawals ---------------------------------------------------------
  if (action === "approveWithdrawal" || action === "rejectWithdrawal") {
    const approve = action === "approveWithdrawal";
    const { data: row } = await sb
      .from("withdrawal_requests")
      .select("id, user_id, email, nickname, amount, method, account, status")
      .eq("id", Number(body.id))
      .maybeSingle();

    if (!row) return json({ error: "Request not found" }, 404);
    if (row.status !== "pending") return json({ error: "Already decided" }, 409);

    const { data: upd } = await sb
      .from("withdrawal_requests")
      .update({ status: approve ? "approved" : "rejected", decided_at: now, decided_by: actor })
      .eq("id", row.id).eq("status", "pending").select("id");
    if (!upd?.length) return json({ error: "Already decided" }, 409);

    let balance = null;
    if (approve) {
      if (!row.user_id) return json({ error: "Request has no linked account" }, 400);
      const { data: bal, error } = await sb.rpc("apply_wallet_delta", {
        p_user_id: row.user_id,
        p_delta: -Number(row.amount),
        p_reason: `Withdrawal approved (${row.method} – ${row.account})`,
        p_type: "DEBIT",
      });
      if (error) {
        const freed = await releaseClaim(sb, "withdrawal_requests", row.id, audit);
        await audit("Withdrawal Not Paid",
          `${row.email}: ₱${row.amount} could not be paid (${error.message}). ` +
          `Nothing was sent and nothing left the wallet.`);
        return json({ error: error.message, requestReturnedToQueue: freed }, 400);
      }
      balance = bal?.[0]?.post_balance;
    }

    await audit(approve ? "Withdrawal Approved" : "Withdrawal Rejected",
      `${row.email}: ₱${row.amount} via ${row.method}`);
    return json({ ok: true, balance });
  }

  // ---- registration approval ----------------------------------------------
  if (action === "approveRegistration" || action === "rejectRegistration") {
    const approve = action === "approveRegistration";
    const email = String(body.email ?? "");
    if (!email) return json({ error: "email required" }, 400);

    // The 50-peso fee is collected outside the app, against the receipt the
    // player uploaded, and was never recorded anywhere. Record it on approval
    // so it shows up as revenue. It is deliberately NOT a wallet credit: it is
    // a fee the owner keeps, not balance the player can wager or withdraw.
    await sb.from("profiles")
      .update(approve
        // approved_at is when the fee is earned, which is not when the player
        // signed up - the earnings report ranges on it.
        ? { status: "active", approved: true, registration_fee: REGISTRATION_FEE,
            approved_at: now }
        : { status: "rejected", approved: false })
      .eq("email", email);

    await audit(approve ? "Registration Approved" : "Registration Rejected", email);
    return json({ ok: true });
  }

  // ---- delete a player, for real ------------------------------------------
  // Nothing in this schema has a foreign key, so deleting the auth user alone
  // would strand their ledger, duels and requests as orphan rows keyed to a
  // user_id that no longer exists. Every table that references the player is
  // cleared explicitly, and the audit row is written BEFORE the delete so the
  // trail survives the account.
  if (action === "deletePlayer") {
    const email = String(body.email ?? "");
    const force = Boolean(body.force);
    if (!email) return json({ error: "email required" }, 400);

    const { data: target } = await sb.from("profiles")
      .select("user_id, email, nickname, wallet, wins, xp, role")
      .eq("email", email).maybeSingle();
    if (!target) return json({ error: "Player not found" }, 404);

    // An owner must not be able to delete themselves or another admin by
    // mistake: that would lock everyone out of the portal.
    const { data: isAdmin } = await sb.from("admins")
      .select("user_id").eq("email", email).maybeSingle();
    if (target.role === "owner" || isAdmin) {
      return json({ error: "Admin and owner accounts cannot be deleted here" }, 403);
    }

    // Deleting a player who still holds money destroys the record of what is
    // owed to them. Refuse unless the caller says so deliberately.
    const balance = Number(target.wallet ?? 0);
    if (balance > 0 && !force) {
      return json({ error: `That account still holds \u20b1${balance}. Withdraw or zero the balance first, or confirm again to delete anyway.`,
                    needsForce: true, balance }, 409);
    }

    await audit("Player Deleted",
      `${email} (${target.nickname}) - final balance \u20b1${balance}, ${target.wins} wins, ${target.xp} XP`);

    const uid = target.user_id;
    if (uid) {
      for (const t of ["wallet_ledger", "battle_history", "topup_requests",
                       "withdrawal_requests", "balance_adjustments", "support_messages"]) {
        await sb.from(t).delete().eq("user_id", uid);
      }
      // A PvP duel holds two players, and this one may be either of them.
      // Matching on user_id alone left the opponent's duels behind, pointing
      // at a profile that no longer exists.
      await sb.from("duel_sessions").delete()
        .or(`user_id.eq.${uid},opponent_user_id.eq.${uid}`);
    }
    for (const t of ["pending_registrations", "registrations", "players", "topups",
                     "withdrawals", "resets", "support_chats"]) {
      await sb.from(t).delete().eq("email", email);
    }
    await sb.from("matchmaking_queue").delete().eq("player_email", email);
    await sb.from("profiles").delete().eq("email", email);

    // Last, so a failure above leaves the account recoverable rather than
    // leaving an auth user with no profile.
    let authDeleted = false;
    if (uid) {
      const { error } = await sb.auth.admin.deleteUser(uid);
      authDeleted = !error;
      if (error) {
        await audit("Player Delete Warning",
          `${email}: profile removed but the auth user remains (${error.message})`);
      }
    }

    return json({ ok: true, email, authDeleted, balance });
  }

  // ---- what the arena earned, and what it owes -----------------------------
  // Read-only, and admin membership was already checked at the top of this
  // handler. owner_earnings is SECURITY DEFINER with EXECUTE revoked from
  // every client role, so this is the only way to reach it.
  if (action === "earnings") {
    const from = String(body.from ?? "") || null;
    const to   = String(body.to ?? "") || null;

    const { data, error } = await sb.rpc("owner_earnings", {
      p_from: from ?? "-infinity",
      p_to:   to   ?? "infinity",
    });
    if (error) return json({ error: error.message }, 400);

    const r = Array.isArray(data) ? data[0] : data;
    if (!r) return json({ error: "No figures returned" }, 500);

    const n = (v: unknown) => Number(v ?? 0);
    return json({
      ok: true,
      from, to,
      revenue: {
        registrations: { count: n(r.reg_count),  amount: n(r.reg_revenue) },
        duelRake:      { count: n(r.duel_count), amount: n(r.duel_rake),
                         volume: n(r.duel_volume) },
        shop:          { count: n(r.shop_count), amount: n(r.shop_revenue) },
        total: n(r.period_revenue),
      },
      cash: {
        depositsPeriod:    n(r.deposits_period),
        withdrawalsPeriod: n(r.withdrawals_period),
        depositsAll:       n(r.deposits_all),
        withdrawalsAll:    n(r.withdrawals_all),
        adjustmentsAll:    n(r.adjustments_all),
        // What should be sitting in the GCash/Maya account right now.
        expected:          n(r.cash_expected),
        // Of that, how much belongs to players and must stay payable.
        owedToPlayers:     n(r.player_balances),
        earnedFromWallets: n(r.earned_from_wallets),
        // Non-zero means money was created or lost outside the ledger.
        discrepancy:       n(r.discrepancy),
      },
    });
  }

  // ---- freeze / unfreeze ---------------------------------------------------
  if (action === "setFrozen") {
    const email = String(body.email ?? "");
    const frozen = Boolean(body.frozen);
    if (!email) return json({ error: "email required" }, 400);

    await sb.from("profiles")
      .update({ frozen, status: frozen ? "frozen" : "active" })
      .eq("email", email);

    await audit(frozen ? "Account Frozen" : "Account Unfrozen", email);
    return json({ ok: true });
  }

  // ---- manual balance adjustment ------------------------------------------
  if (action === "adjustBalance") {
    const email = String(body.email ?? "");
    const amount = Number(body.amount);
    if (!email || !Number.isFinite(amount) || amount === 0) {
      return json({ error: "email and a non-zero amount are required" }, 400);
    }

    const { data: target } = await sb
      .from("profiles").select("user_id, nickname, wallet").eq("email", email).maybeSingle();
    if (!target?.user_id) return json({ error: "Player not found" }, 404);

    const { data: bal, error } = await sb.rpc("apply_wallet_delta", {
      p_user_id: target.user_id,
      p_delta: amount,
      p_reason: `Manual balance adjustment by ${actor}`,
      p_type: amount >= 0 ? "CREDIT" : "DEBIT",
    });
    if (error) return json({ error: error.message }, 400);

    const pre = bal?.[0]?.pre_balance;
    const post = bal?.[0]?.post_balance;

    await sb.from("balance_adjustments").insert([{
      user_id: target.user_id, email, nickname: target.nickname, amount,
      pre_balance: pre, post_balance: post, actor,
      date: now.split("T")[0], time: new Date().toTimeString().slice(0, 8),
    }]);

    await audit("Manual Balance Adjustment",
      `${email}: ₱${pre} ➔ ₱${post} (${amount >= 0 ? "+" : ""}${amount})`);
    return json({ ok: true, pre_balance: pre, post_balance: post });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
