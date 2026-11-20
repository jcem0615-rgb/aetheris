import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.49.4";

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
      if (error) return json({ error: error.message }, 400);
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
      if (error) return json({ error: error.message }, 400);
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

    await sb.from("profiles")
      .update(approve
        ? { status: "active", approved: true }
        : { status: "rejected", approved: false })
      .eq("email", email);

    await audit(approve ? "Registration Approved" : "Registration Rejected", email);
    return json({ ok: true });
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
