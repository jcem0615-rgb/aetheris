import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.49.4";

// Turns "a payment arrived" into "the player's wallet went up", exactly once.
//
// Nothing calls this automatically yet: Philippine gateways will not onboard a
// wagering merchant, so there is no webhook to receive. It exists because the
// hard part of accepting payments is not the gateway, it is crediting the right
// wallet once and only once, and that part is the same whoever reports the
// payment - a gateway later, a notification bridge, or the owner by hand.
//
// The ordering below is the whole design:
//
//   1. Record the event FIRST. (provider, external_id) is unique, so a webhook
//      retry loses the race in the database rather than in application code.
//   2. Claim the top-up request with a conditional update out of 'pending'.
//      That claim - not anything here - is what decides whether a request has
//      been paid, so this path and the owner's manual Approve button cannot
//      both pay the same one.
//   3. Only then move money.
//
// A retry of an event that was recorded but never finished is RESUMED, not
// waved through. Returning "already processed" for an attempt that crashed
// before crediting would swallow a real payment.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHARED_SECRET = Deno.env.get("PAYMENT_WEBHOOK_SECRET") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-payment-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const db = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Length-independent comparison. A plain === leaks where two secrets diverge
// through timing; this does not, and costs nothing here.
function secretsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// Money compared in centavos. 500.1 + 0.2 style drift has no business
// deciding whether a payment matches a request.
const cents = (n: number) => Math.round(n * 100);

// Normalises what the payer typed. Wallet message fields arrive lowercased,
// spaced, or with the prefix dropped.
function normaliseRef(raw: unknown): string | null {
  const s = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return null;
  const m = s.match(/AET([A-Z0-9]{4})/);
  if (m) return `AET-${m[1]}`;
  // a bare code with the prefix left off
  if (/^[A-Z0-9]{4}$/.test(s)) return `AET-${s}`;
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const sb = db();

  // ---- who is allowed to say a payment happened ---------------------------
  // Either the shared secret (what an automated feed would send) or an admin
  // signed into the portal. Nothing else moves money.
  let actor = "";
  const offered = req.headers.get("x-payment-secret") ?? "";
  if (SHARED_SECRET && secretsMatch(offered, SHARED_SECRET)) {
    actor = "payment-feed";
  } else {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: auth } = await sb.auth.getUser(token);
    if (!auth?.user) return json({ error: "Not authorised" }, 401);
    const { data: adminRow } = await sb.from("admins")
      .select("email").eq("user_id", auth.user.id).maybeSingle();
    if (!adminRow) return json({ error: "Not authorised" }, 403);
    actor = adminRow.email;
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const audit = (what: string, detail: string) =>
    sb.from("audit_logs").insert([{ action: what, details: detail, performed_by: actor }]);

  // ---- what we were told --------------------------------------------------
  const provider = String(body.provider ?? "").trim().slice(0, 40) || "manual";
  const externalId = String(body.externalId ?? body.external_id ?? "").trim().slice(0, 120);
  const amount = Number(body.amount);
  const reference = normaliseRef(body.reference);
  const method = String(body.method ?? "").trim().slice(0, 20) || null;
  const payerName = String(body.payerName ?? body.payer_name ?? "").trim().slice(0, 120) || null;

  if (!externalId) {
    return json({ error: "externalId is required - it is what makes this idempotent" }, 400);
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    return json({ error: "A positive amount under ₱1,000,000 is required" }, 400);
  }

  // ---- 1. record it, and let the database reject a replay ------------------
  const { data: inserted, error: insErr } = await sb.from("payment_events").insert([{
    provider, external_id: externalId, amount, reference, method,
    payer_name: payerName, status: "received", raw: body,
  }]).select("id").maybeSingle();

  let eventId: number;
  if (insErr) {
    // 23505 is the unique violation: we have seen this payment before.
    if (insErr.code !== "23505") return json({ error: insErr.message }, 400);

    const { data: prior } = await sb.from("payment_events")
      .select("id, status, amount, topup_request_id, credited_user_id, note")
      .eq("provider", provider).eq("external_id", externalId).maybeSingle();

    if (!prior) return json({ error: "Duplicate reported but the original is missing" }, 500);

    // Settled already: say what happened and move no money.
    if (prior.status !== "received") {
      return json({
        ok: true, duplicate: true, outcome: prior.status,
        eventId: prior.id, requestId: prior.topup_request_id, note: prior.note,
        message: "Already processed - nothing was credited again.",
      });
    }
    // Recorded but never finished. Pick it up where it stopped.
    eventId = prior.id;
  } else {
    eventId = inserted!.id;
  }

  const settle = (status: string, fields: Record<string, unknown> = {}) =>
    sb.from("payment_events")
      .update({ status, settled_at: new Date().toISOString(), ...fields })
      .eq("id", eventId);

  // ---- 2. find what it pays for -------------------------------------------
  if (!reference) {
    await settle("unmatched", { note: "No AET-XXXX code was quoted with the payment." });
    await audit("Payment Unmatched",
      `₱${amount} from ${payerName ?? "unknown"} via ${provider} carried no pay code (${externalId})`);
    return json({ ok: true, outcome: "unmatched", eventId,
      message: "Recorded, but no pay code was quoted. It needs matching by hand." });
  }

  const { data: candidates } = await sb.from("topup_requests")
    .select("id, user_id, email, nickname, amount, ref, pay_code, status")
    .eq("pay_code", reference).eq("status", "pending")
    .order("created_at", { ascending: true });

  const request = (candidates ?? [])[0];
  if (!request) {
    await settle("unmatched", { note: `No pending request is waiting on ${reference}.` });
    await audit("Payment Unmatched",
      `₱${amount} quoting ${reference} matched no pending request (${provider} ${externalId})`);
    return json({ ok: true, outcome: "unmatched", eventId, reference,
      message: `No pending top-up is waiting on ${reference}. It needs matching by hand.` });
  }

  // ---- 3. the amount must be the amount -----------------------------------
  // Crediting a figure the player did not send, or holding back one they did,
  // are both wrong. Anything that is not an exact match is the owner's call.
  if (cents(Number(request.amount)) !== cents(amount)) {
    await settle("review", {
      topup_request_id: request.id,
      note: `Player asked for ₱${request.amount} but ₱${amount} arrived.`,
    });
    await audit("Payment Needs Review",
      `${request.email}: requested ₱${request.amount}, received ₱${amount} ` +
      `against ${reference} (${provider} ${externalId})`);
    return json({ ok: true, outcome: "review", eventId, requestId: request.id,
      expected: Number(request.amount), received: amount,
      message: `Amount does not match: ₱${request.amount} requested, ₱${amount} received. Held for you to decide.` });
  }

  if (!request.user_id) {
    await settle("review", { topup_request_id: request.id,
      note: "The request has no linked account to credit." });
    return json({ ok: true, outcome: "review", eventId, requestId: request.id,
      message: "That request has no linked account. Held for review." });
  }

  // ---- 4. claim it, then pay ----------------------------------------------
  // Whoever flips the row out of 'pending' owns it. The owner's Approve button
  // uses the same conditional update, so only one of the two can ever win.
  const now = new Date().toISOString();
  const { data: claimed } = await sb.from("topup_requests")
    .update({ status: "approved", decided_at: now, decided_by: actor })
    .eq("id", request.id).eq("status", "pending").select("id");

  if (!claimed?.length) {
    await settle("review", { topup_request_id: request.id,
      note: "The request was decided by someone else before this payment landed." });
    return json({ ok: true, outcome: "review", eventId, requestId: request.id,
      message: "That request was already decided elsewhere. Nothing was credited twice." });
  }

  const { data: bal, error: walletErr } = await sb.rpc("apply_wallet_delta", {
    p_user_id: request.user_id,
    p_delta: amount,
    p_reason: `Top-Up approved (Ref: ${request.ref})`,
    p_type: "CREDIT",
  });

  if (walletErr) {
    // Put the request back exactly as it was, the same way admin-actions does,
    // so it is not left reading 'approved' with no money behind it.
    const { error: relErr } = await sb.from("topup_requests")
      .update({ status: "pending", decided_at: null, decided_by: null })
      .eq("id", request.id);
    await settle("review", { topup_request_id: request.id,
      note: `The wallet did not move: ${walletErr.message}` });
    await audit("Payment Not Credited",
      `${request.email}: ₱${amount} arrived against ${reference} but the wallet ` +
      `did not move (${walletErr.message}).` +
      (relErr ? ` The request could not be returned to pending either - fix it by hand.` : ""));
    return json({ error: walletErr.message, outcome: "review", eventId,
      requestReturnedToQueue: !relErr }, 400);
  }

  const balance = bal?.[0]?.post_balance;
  await settle("credited", {
    topup_request_id: request.id,
    credited_user_id: request.user_id,
    note: `Credited ₱${amount} automatically.`,
  });
  await audit("Top-Up Auto-Credited",
    `${request.email}: ₱${amount} against ${reference} via ${provider} (${externalId})`);

  return json({ ok: true, outcome: "credited", eventId, requestId: request.id,
    email: request.email, amount, balance,
    message: `Credited ₱${amount} to ${request.nickname}.` });
});
