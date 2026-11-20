import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Prices and gates live here, not in the page, so the client cannot set them.
const HEROES: Record<string, { price: number; wins: number; xp: number; starter: boolean }> = {
  "pyra":             { price: 200,  wins: 0,  xp: 0,    starter: true },
  "sylph":            { price: 200,  wins: 0,  xp: 0,    starter: true },
  "valen":            { price: 200,  wins: 0,  xp: 0,    starter: true },
  "nyx":              { price: 200,  wins: 0,  xp: 0,    starter: true },
  "storm-knight":     { price: 350,  wins: 2,  xp: 150,  starter: false },
  "ironclad-titan":   { price: 500,  wins: 4,  xp: 350,  starter: false },
  "chrono-warden":    { price: 750,  wins: 7,  xp: 600,  starter: false },
  "sky-valkyrie":     { price: 1000, wins: 10, xp: 950,  starter: false },
  "void-necromancer": { price: 1500, wins: 15, xp: 1400, starter: false },
  "blood-berserker":  { price: 2500, wins: 25, xp: 2500, starter: false },
  "astral-archmage":  { price: 3500, wins: 30, xp: 3200, starter: false },
};

const SKILLS: Record<string, { price: number; hero: string }> = {
  "shop-pyra-2":     { price: 150, hero: "pyra" },
  "shop-pyra-3":     { price: 500, hero: "pyra" },
  "shop-sylph-2":    { price: 150, hero: "sylph" },
  "shop-sylph-3":    { price: 500, hero: "sylph" },
  "shop-valen-2":    { price: 150, hero: "valen" },
  "shop-valen-3":    { price: 500, hero: "valen" },
  "shop-nyx-2":      { price: 150, hero: "nyx" },
  "shop-nyx-3":      { price: 500, hero: "nyx" },
  "shop-storm-2":    { price: 200, hero: "storm-knight" },
  "shop-storm-3":    { price: 500, hero: "storm-knight" },
  "shop-titan-2":    { price: 200, hero: "ironclad-titan" },
  "shop-titan-3":    { price: 500, hero: "ironclad-titan" },
  "shop-chrono-2":   { price: 250, hero: "chrono-warden" },
  "shop-chrono-3":   { price: 500, hero: "chrono-warden" },
  "shop-valkyrie-2": { price: 250, hero: "sky-valkyrie" },
  "shop-valkyrie-3": { price: 500, hero: "sky-valkyrie" },
  "shop-void-2":     { price: 300, hero: "void-necromancer" },
  "shop-void-3":     { price: 500, hero: "void-necromancer" },
  "shop-berserk-2":  { price: 300, hero: "blood-berserker" },
  "shop-berserk-3":  { price: 500, hero: "blood-berserker" },
  "shop-astral-2":   { price: 350, hero: "astral-archmage" },
  "shop-astral-3":   { price: 500, hero: "astral-archmage" },
};

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
  const uid = auth.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { data: p } = await sb
    .from("profiles")
    .select("user_id, wallet, wins, xp, unlocked_heroes, unlocked_skills, approved, frozen")
    .eq("user_id", uid)
    .maybeSingle();

  if (!p) return json({ error: "No profile" }, 403);
  if (p.frozen) return json({ error: "Account is frozen" }, 403);
  if (!p.approved) return json({ error: "Account is not approved yet" }, 403);

  const action = String(body.action ?? "");
  const owned: string[] = Array.isArray(p.unlocked_heroes) ? p.unlocked_heroes : [];
  const skills: Record<string, boolean> = (p.unlocked_skills as Record<string, boolean>) ?? {};

  // ---- claim the one free starter hero ------------------------------------
  if (action === "claimStarter") {
    const heroId = String(body.heroId ?? "");
    const hero = HEROES[heroId];
    if (!hero || !hero.starter) return json({ error: "Not a starter hero" }, 400);
    if (owned.length > 0) return json({ error: "Starter already claimed" }, 409);

    await sb.from("profiles")
      .update({ unlocked_heroes: [heroId], active_hero: heroId })
      .eq("user_id", uid);

    return json({ heroId, unlocked_heroes: [heroId] });
  }

  // ---- buy a hero ----------------------------------------------------------
  if (action === "buyHero") {
    const heroId = String(body.heroId ?? "");
    const hero = HEROES[heroId];
    if (!hero) return json({ error: "Unknown hero" }, 400);
    if (owned.includes(heroId)) return json({ error: "Already unlocked" }, 409);

    if (Number(p.wins ?? 0) < hero.wins || Number(p.xp ?? 0) < hero.xp) {
      return json({ error: `Requires ${hero.wins} wins and ${hero.xp} EXP` }, 403);
    }
    if (Number(p.wallet ?? 0) < hero.price) return json({ error: "Insufficient balance" }, 400);

    const { data: bal, error } = await sb.rpc("apply_wallet_delta", {
      p_user_id: uid,
      p_delta: -hero.price,
      p_reason: `Purchased hero: ${heroId}`,
      p_type: "DEBIT",
    });
    if (error) return json({ error: error.message }, 400);

    const next = [...owned, heroId];
    await sb.from("profiles")
      .update({ unlocked_heroes: next, active_hero: heroId })
      .eq("user_id", uid);

    return json({ heroId, price: hero.price, balance: bal?.[0]?.post_balance, unlocked_heroes: next });
  }

  // ---- buy a skill ---------------------------------------------------------
  if (action === "buySkill") {
    const skillId = String(body.skillId ?? "");
    const skill = SKILLS[skillId];
    if (!skill) return json({ error: "Unknown skill" }, 400);
    if (skills[skillId]) return json({ error: "Already owned" }, 409);
    if (!owned.includes(skill.hero)) return json({ error: "You do not own that hero" }, 403);
    if (Number(p.wallet ?? 0) < skill.price) return json({ error: "Insufficient balance" }, 400);

    const { data: bal, error } = await sb.rpc("apply_wallet_delta", {
      p_user_id: uid,
      p_delta: -skill.price,
      p_reason: `Purchased skill: ${skillId}`,
      p_type: "DEBIT",
    });
    if (error) return json({ error: error.message }, 400);

    const nextSkills = { ...skills, [skillId]: true };
    await sb.from("profiles").update({ unlocked_skills: nextSkills }).eq("user_id", uid);

    return json({ skillId, price: skill.price, balance: bal?.[0]?.post_balance, unlocked_skills: nextSkills });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
