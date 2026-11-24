import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PLATFORM_FEE = 0.05;
const ALLOWED_STAKES = [50, 100, 200, 500, 1000];
const MAX_HP = 150;
const AP_PER_TURN = 3;
const HAND_SIZE = 4;
// The opponent opens half of all duels, so its opening swing can be capped
// below AP_PER_TURN if it ever starts ending duels before the player touches
// a card. At the 150 HP pool it does not, so the cap is off. Lowering it makes
// the arena gentler and less profitable: at the old 100 HP pool, capping this
// to 1 took the house from +4.6% to -18.3%. Measure with tools/duel-sim.
const OPENING_AP = AP_PER_TURN;

// The server's own copy of every card's effect, generated from the game
// tables. The browser receives card IDs only and looks names up locally for
// display; every number below is applied here and never trusted from input.
// tools/duel-sim/check-cards.mjs fails if this disagrees with index.html.
//
// The base decks come off one power curve: for a given tier every hero has the
// same strike, guard and signature damage, so a hero's best turn is the same
// number for everyone on that rung and rises monotonically up the ladder.
// Flavour -- burn, healing, armour -- is the only difference between heroes,
// and the magnitudes are set so the three are worth the same. Before this,
// slot 4 was a pure heal or pure shield for seven heroes, which cost 2 of 3 AP
// and dealt nothing: Valen won 23% of duels and Storm Knight 29%.
const CARD_TABLE = "pyra-1,1,26,0,0,0,FLAME DART|pyra-2,1,0,14,0,0,FIRE SHIELD|pyra-3,2,33,0,0,6,SCORCH|pyra-4,2,22,0,14,0,BLAZING HEAL|sylph-1,1,28,0,0,0,GALE SLASH|sylph-2,1,0,15,0,0,WIND STEP|sylph-3,2,35,0,0,6,GALE ARROW|sylph-4,2,24,0,15,0,WIND MEND|valen-1,1,31,0,0,0,SHIELD BASH|valen-2,1,0,17,0,0,IRON BASTION|valen-3,2,39,0,0,0,HEAVY SLAM|valen-4,2,31,21,0,0,FORTIFY|nyx-1,1,33,0,0,0,SHADOW STAB|nyx-2,1,0,18,0,0,SMOKE CLOAK|nyx-3,2,42,0,0,7,VENOM BLADE|nyx-4,2,29,0,18,0,LIFE SIPHON|storm-1,1,36,0,0,0,SPARK STRIKE|storm-2,1,0,20,0,0,STATIC GUARD|storm-3,2,46,0,0,0,LIGHTNING BOLT|storm-4,2,36,0,33,0,ELECTRO MEND|titan-1,1,40,0,0,0,STONE SMASH|titan-2,1,0,22,0,0,TECTONIC BLOCK|titan-3,2,51,0,0,0,EARTHQUAKE|titan-4,2,40,28,0,0,TITAN MEND|chrono-1,1,44,0,0,0,TIME SLASH|chrono-2,1,0,24,0,0,TEMPORAL WARD|chrono-3,2,56,0,0,0,TIME WARP|chrono-4,2,44,0,39,0,HOURGLASS HEAL|valkyrie-1,1,48,0,0,0,HOLY SPEAR|valkyrie-2,1,0,26,0,0,RADIANT SHIELD|valkyrie-3,2,61,0,0,0,CELESTIAL STRIKE|valkyrie-4,2,48,0,43,0,DIVINE MEND|void-1,1,52,0,0,0,DARK BOLT|void-2,1,0,28,0,0,SOUL BARRIER|void-3,2,66,0,0,12,PLAGUE WAVE|void-4,2,45,0,28,0,ABYSSAL DRAIN|berserk-1,1,57,0,0,0,BLOOD AXE|berserk-2,1,0,31,0,0,FRENZIED BLOCK|berserk-3,2,72,0,0,0,BLOODY RAMPAGE|berserk-4,2,57,0,51,0,BLOOD FEAST|astral-1,1,60,0,0,0,STELLAR RAY|astral-2,1,0,32,0,0,COSMIC BARRIER|astral-3,2,77,0,0,0,SUPERNOVA|astral-4,2,60,0,54,0,ASTRAL MEND|shop-pyra-2,2,55,0,0,15,INFERNAL HELLFIRE|shop-pyra-3,3,95,0,0,0,SOLAR SUPERNOVA|shop-sylph-2,2,58,0,0,0,HURRICANE BARRAGE|shop-sylph-3,3,90,0,0,0,HURRICANE APOCALYPSE|shop-valen-2,2,50,22,0,0,AEGIS FORTRESS|shop-valen-3,3,78,35,0,0,DIVINE INVINCIBILITY|shop-nyx-2,2,62,0,0,0,SHADOW ASSASSINATION|shop-nyx-3,3,95,0,0,20,ABSOLUTE SHADOW ECLIPSE|shop-storm-2,2,65,0,0,0,THUNDER GODS WRATH|shop-storm-3,3,100,0,0,0,ZEUS THUNDERSTORM|shop-titan-2,2,68,0,0,0,CONTINENTAL CRUSH|shop-titan-3,3,105,0,0,0,WORLD SHATTERING METEOR|shop-chrono-2,2,58,0,24,0,TEMPORAL REWIND|shop-chrono-3,3,88,0,38,0,ETERNAL TIME COLLAPSE|shop-valkyrie-2,2,70,0,0,0,DIVINE JUDGMENT|shop-valkyrie-3,3,105,0,0,0,HEAVENLY RAGNAROK|shop-void-2,2,65,0,25,0,SOUL HARVEST|shop-void-3,3,110,0,0,0,VOID REALM ANNIHILATION|shop-berserk-2,2,75,0,0,0,APOCALYPSE FRENZY|shop-berserk-3,3,115,0,0,0,RAGING BLOOD GOD RAMPAGE|shop-astral-2,2,80,0,0,0,GALAXY COLLAPSE|shop-astral-3,3,120,0,0,0,BIG BANG UNIVERSE STRIKE";

const BASE_TABLE = "pyra:pyra-1,pyra-2,pyra-3,pyra-4|sylph:sylph-1,sylph-2,sylph-3,sylph-4|valen:valen-1,valen-2,valen-3,valen-4|nyx:nyx-1,nyx-2,nyx-3,nyx-4|storm-knight:storm-1,storm-2,storm-3,storm-4|ironclad-titan:titan-1,titan-2,titan-3,titan-4|chrono-warden:chrono-1,chrono-2,chrono-3,chrono-4|sky-valkyrie:valkyrie-1,valkyrie-2,valkyrie-3,valkyrie-4|void-necromancer:void-1,void-2,void-3,void-4|blood-berserker:berserk-1,berserk-2,berserk-3,berserk-4|astral-archmage:astral-1,astral-2,astral-3,astral-4";

const SHOP_TABLE = "pyra:shop-pyra-2,shop-pyra-3|sylph:shop-sylph-2,shop-sylph-3|valen:shop-valen-2,shop-valen-3|nyx:shop-nyx-2,shop-nyx-3|storm-knight:shop-storm-2,shop-storm-3|ironclad-titan:shop-titan-2,shop-titan-3|chrono-warden:shop-chrono-2,shop-chrono-3|sky-valkyrie:shop-valkyrie-2,shop-valkyrie-3|void-necromancer:shop-void-2,shop-void-3|blood-berserker:shop-berserk-2,shop-berserk-3|astral-archmage:shop-astral-2,shop-astral-3";

interface Card { ap: number; damage: number; armor: number; heal: number; poison: number; name: string }

const CARDS: Record<string, Card> = {};
for (const row of CARD_TABLE.split("|")) {
  const p = row.split(",");
  CARDS[p[0]] = { ap: +p[1], damage: +p[2], armor: +p[3], heal: +p[4], poison: +p[5], name: p[6] };
}

function parseDecks(table: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of table.split("|")) {
    const [hero, ids] = row.split(":");
    out[hero] = ids.split(",");
  }
  return out;
}
const HERO_BASE = parseDecks(BASE_TABLE);
const HERO_SHOP = parseDecks(SHOP_TABLE);

const BOT_NAMES = ["Kenjie","Kenneth","Clyde","Joana","Glenda","Glenn","Mark","Jessa","Bryan","Rica","Christian","Nicole","Jomar","Kaye","Roldan"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const db = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Server-side RNG: the client cannot predict or steer a shuffle or a bot move.
function rnd(n: number) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}
function pick<T>(a: T[]): T { return a[rnd(a.length)]; }

interface State {
  heroId: string; enemyHeroId: string; opponent: string;
  playerHp: number; playerArmor: number; playerAp: number; playerPoison: number;
  enemyHp: number; enemyArmor: number; enemyPoison: number;
  deck: string[]; enemyDeck?: string[]; botFirst?: boolean;
  hand: string[]; turn: number; log: string;
}

function deckFor(heroId: string, owned: Record<string, boolean>): string[] {
  const deck = [...(HERO_BASE[heroId] ?? HERO_BASE["pyra"])];
  for (const id of (HERO_SHOP[heroId] ?? [])) {
    if (owned && owned[id]) deck.push(id);
  }
  return deck;
}

function deal(deck: string[]): string[] {
  const pool = [...deck];
  const hand: string[] = [];
  for (let i = 0; i < Math.min(HAND_SIZE, pool.length); i++) {
    hand.push(pool.splice(rnd(pool.length), 1)[0]);
  }
  return hand;
}

// Armour absorbs damage first, exactly as the UI shows. Nothing in this engine
// bypasses it, which is why no card text claims to.
function hit(dmg: number, armor: number) {
  if (armor >= dmg) return { dmg: 0, armor: armor - dmg };
  return { dmg: dmg - armor, armor: 0 };
}

// HERO_BASE is ordered weakest to strongest, so a hero's index is its tier.
const HERO_LADDER = Object.keys(HERO_BASE);

// The opponent is drawn from the player's own tier, give or take one rung.
// Drawn uniformly, a Pyra player met an Astral Archmage one duel in eleven and
// was flattened before acting, while an Astral player farmed the bottom of the
// ladder.
function matchOpponentHero(heroId: string): string {
  const i = HERO_LADDER.indexOf(heroId);
  if (i < 0) return pick(HERO_LADDER);
  const lo = Math.max(0, i - 1);
  const hi = Math.min(HERO_LADDER.length - 1, i + 1);
  return HERO_LADDER[lo + rnd(hi - lo + 1)];
}

// The opponent is built to the player's own loadout: buy shop skills and you
// meet someone who has them too. Left unmatched, a player holding both shop
// skills won about three duels in four, which no 5% fee can cover.
function botDeckFor(enemyHeroId: string, heroId: string, owned: Record<string, boolean>): string[] {
  const mine = HERO_SHOP[heroId] ?? [];
  const ownedCount = mine.filter((id) => owned && owned[id]).length;
  const deck = [...(HERO_BASE[enemyHeroId] ?? HERO_BASE["pyra"])];
  for (const id of (HERO_SHOP[enemyHeroId] ?? []).slice(0, ownedCount)) deck.push(id);
  return deck;
}

// The bot takes its turn under the player's rules: three AP, a hand of four,
// and each card's real effect. It used to invent one flat number per turn,
// so its shields and heals landed as 25-damage attacks and its own armour,
// healing and poison were never applied at all.
function botTurn(s: State, apBudget: number = AP_PER_TURN): string {
  const deck = s.enemyDeck ?? HERO_BASE[s.enemyHeroId] ?? HERO_BASE["pyra"];
  const hand = deal(deck);
  let ap = apBudget;
  let msg = "";

  for (let guard = 0; guard < HAND_SIZE; guard++) {
    const affordable = hand
      .map((id, i) => ({ i, c: CARDS[id] }))
      .filter((x) => x.c && x.c.ap <= ap);
    if (affordable.length === 0) break;

    // Heal when badly hurt, otherwise hit as hard as the AP allows, and fall
    // back to the best defensive card when no attack is affordable.
    let choice = s.enemyHp < MAX_HP * 0.35
      ? affordable.filter((x) => x.c.heal > 0).sort((a, b) => b.c.heal - a.c.heal)[0]
      : undefined;
    if (!choice) {
      const attacks = affordable.filter((x) => x.c.damage > 0);
      choice = attacks.length
        ? attacks.sort((a, b) => b.c.damage - a.c.damage)[0]
        : affordable.sort((a, b) => (b.c.armor + b.c.heal) - (a.c.armor + a.c.heal))[0];
    }

    const c = choice.c;
    ap -= c.ap;
    hand.splice(choice.i, 1);
    msg += `${s.opponent} used ${c.name}`;

    if (c.damage) {
      const r = hit(c.damage, s.playerArmor);
      s.playerArmor = r.armor;
      s.playerHp = Math.max(0, s.playerHp - r.dmg);
      msg += ` for ${r.dmg} damage`;
    }
    if (c.armor)  { s.enemyArmor += c.armor; msg += `, gaining ${c.armor} armor`; }
    if (c.heal)   { s.enemyHp = Math.min(MAX_HP, s.enemyHp + c.heal); msg += `, healing ${c.heal} HP`; }
    if (c.poison) { s.playerPoison += c.poison; msg += `, applying ${c.poison} poison`; }
    msg += ". ";

    if (s.playerHp <= 0) break;
  }

  return msg || `${s.opponent} had no playable card. `;
}

function publicState(s: State, duelId: string, seq: number, stake: number) {
  return {
    duelId, seq, stake,
    heroId: s.heroId, enemyHeroId: s.enemyHeroId, opponent: s.opponent,
    playerHp: s.playerHp, playerMaxHp: MAX_HP, playerArmor: s.playerArmor,
    playerAp: s.playerAp, playerPoison: s.playerPoison,
    enemyHp: s.enemyHp, enemyMaxHp: MAX_HP, enemyArmor: s.enemyArmor,
    enemyPoison: s.enemyPoison, hand: s.hand, turn: s.turn, log: s.log,
  };
}

// deno-lint-ignore no-explicit-any
async function settle(sb: any, duel: any, profile: any, won: boolean) {
  const stake = Number(duel.stake);
  const payout = won ? stake * 2 * (1 - PLATFORM_FEE) : 0;

  const { data: upd } = await sb.from("duel_sessions")
    .update({ status: "settled", result: won ? "VICTORY" : "DEFEAT", payout, settled_at: new Date().toISOString() })
    .eq("id", duel.id).eq("status", "active").select("id");

  if (!upd || upd.length === 0) return null;

  let balance = Number(profile.wallet);
  if (won) {
    const { data: bal } = await sb.rpc("apply_wallet_delta", {
      p_user_id: profile.user_id, p_delta: payout,
      p_reason: `Ranked Duel Victory vs ${duel.opponent} (stake returned + winnings)`, p_type: "CREDIT",
    });
    balance = Number(bal?.[0]?.post_balance ?? balance);
    await sb.from("profiles")
      .update({ wins: Number(profile.wins ?? 0) + 1, xp: Number(profile.xp ?? 0) + 100 })
      .eq("user_id", profile.user_id);
  }

  await sb.from("battle_history").insert([{
    user_id: profile.user_id, player_email: profile.email, player_name: profile.nickname,
    opponent: duel.opponent ?? "Opponent", result: won ? "VICTORY" : "DEFEAT",
    wager: stake, bet: stake, pre_balance: Number(profile.wallet) + stake, post_balance: balance,
    date: new Date().toISOString().split("T")[0], time: new Date().toTimeString().slice(0, 8),
  }]);

  return { finished: true, result: won ? "VICTORY" : "DEFEAT", payout,
           netGain: won ? payout - stake : -stake, balance };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const sb = db();
  const { data: authData } = await sb.auth.getUser(token);
  if (!authData?.user) return json({ error: "Not signed in" }, 401);
  const uid = authData.user.id;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action ?? "");

  const { data: profile } = await sb.from("profiles")
    .select("user_id, email, nickname, wallet, wins, xp, approved, frozen, active_hero, unlocked_skills")
    .eq("user_id", uid).maybeSingle();

  if (!profile) return json({ error: "No profile" }, 403);
  if (profile.frozen) return json({ error: "Account is frozen" }, 403);
  if (!profile.approved) return json({ error: "Account is not approved yet" }, 403);

  // ---- start: take the stake and build the opening board ------------------
  if (action === "escrow") {
    const stake = Number(body.stake);
    if (!ALLOWED_STAKES.includes(stake)) return json({ error: "Invalid stake" }, 400);
    if (Number(profile.wallet) < stake) return json({ error: "Insufficient balance" }, 400);

    await sb.rpc("expire_stale_duels");

    const heroId = profile.active_hero ?? "pyra";
    const enemyHeroId = matchOpponentHero(heroId);
    const opponent = pick(BOT_NAMES);
    const owned = (profile.unlocked_skills ?? {}) as Record<string, boolean>;
    const deck = deckFor(heroId, owned);
    const enemyDeck = botDeckFor(enemyHeroId, heroId, owned);

    const state: State = {
      heroId, enemyHeroId, opponent,
      playerHp: MAX_HP, playerArmor: 0, playerAp: AP_PER_TURN, playerPoison: 0,
      enemyHp: MAX_HP, enemyArmor: 0, enemyPoison: 0,
      deck, enemyDeck, botFirst: rnd(2) === 0,
      hand: deal(deck), turn: 1,
      log: "Match connected! Choose tactical skills.",
    };

    const { data: duel, error: duelErr } = await sb.from("duel_sessions")
      .insert([{ user_id: uid, stake, opponent, state, seq: 0 }])
      .select("id, stake").single();

    if (duelErr) return json({ error: "You already have a duel in progress" }, 409);

    const { data: bal, error: balErr } = await sb.rpc("apply_wallet_delta", {
      p_user_id: uid, p_delta: -stake,
      p_reason: `Ranked Duel wager escrowed (₱${stake} stake)`, p_type: "DEBIT",
    });
    if (balErr) {
      await sb.from("duel_sessions").delete().eq("id", duel.id);
      return json({ error: balErr.message }, 400);
    }

    // Deliberately does NOT return the board. Revealing the hand and the
    // opponent's hero here, while cancel still refunds in full, let a player
    // reroll until they drew a favourable matchup. The board is handed over by
    // "start", which commits the wager.
    return json({ duelId: duel.id, stake, balance: bal?.[0]?.post_balance });
  }

  const { data: duel } = await sb.from("duel_sessions")
    .select("id, stake, status, opponent, state, seq").eq("id", String(body.duelId ?? ""))
    .eq("user_id", uid).maybeSingle();

  if (!duel) return json({ error: "Duel not found" }, 404);
  if (duel.status !== "active") return json({ error: "Duel already finished" }, 409);

  const s: State = duel.state as State;
  const stake = Number(duel.stake);

  // Commits the wager and reveals the board. seq moves 0 -> 1, which is what
  // cancel and the stale-duel sweep read as "this duel has begun".
  if (action === "start") {
    if (duel.seq === 0) {
      // Initiative was decided at escrow. The player used to open every duel,
      // and since most heroes can spend three AP for more than 100 damage, the
      // better opening hand simply won before the opponent acted at all.
      if (s.botFirst) {
        const opening = botTurn(s, OPENING_AP);
        if (s.playerHp <= 0) {
          s.log = `${opening}You were struck down before you could move.`;
          await sb.from("duel_sessions")
            .update({ state: s, seq: 1, last_action_at: new Date().toISOString() })
            .eq("id", duel.id).eq("seq", 0);
          const out = await settle(sb, duel, profile, false);
          return json({ ...publicState(s, duel.id, 1, stake), ...(out ?? {}) });
        }
        s.log = `${s.opponent} moves first. ${opening}Your turn.`;
      }
      await sb.from("duel_sessions")
        .update({ state: s, seq: 1, last_action_at: new Date().toISOString() })
        .eq("id", duel.id).eq("seq", 0);
      return json(publicState(s, duel.id, 1, stake));
    }
    // Already started: hand back the live board, so a refresh resumes.
    return json(publicState(s, duel.id, duel.seq, stake));
  }

  if (action === "getState") {
    if (duel.seq === 0) return json({ duelId: duel.id, stake, started: false });
    return json(publicState(s, duel.id, duel.seq, stake));
  }

  if (action === "cancel") {
    // seq > 0 means the board has been revealed, so the wager is live.
    if (duel.seq > 0) return json({ error: "The duel has already started" }, 409);
    const { data: upd } = await sb.from("duel_sessions")
      .update({ status: "cancelled", settled_at: new Date().toISOString() })
      .eq("id", duel.id).eq("status", "active").select("id");
    if (!upd?.length) return json({ error: "Duel already settled" }, 409);

    const { data: bal } = await sb.rpc("apply_wallet_delta", {
      p_user_id: uid, p_delta: stake,
      p_reason: "Ranked Duel wager refunded (queue cancelled)", p_type: "CREDIT",
    });
    return json({ cancelled: true, refunded: stake, balance: bal?.[0]?.post_balance });
  }

  if (action === "surrender") {
    const out = await settle(sb, duel, profile, false);
    return out ? json(out) : json({ error: "Duel already settled" }, 409);
  }

  // Replay guard: the client echoes the seq it rendered, so a resent or
  // out-of-order request can never apply the same action twice.
  const clientSeq = Number(body.seq ?? -1);
  if (clientSeq !== duel.seq) {
    return json({ error: "Out of sync", resync: publicState(s, duel.id, duel.seq, stake) }, 409);
  }

  if (action === "playCard") {
    const idx = Number(body.handIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= s.hand.length) {
      return json({ error: "No such card in hand" }, 400);
    }
    const card = CARDS[s.hand[idx]];
    if (!card) return json({ error: "Unknown card" }, 400);
    if (s.playerAp < card.ap) return json({ error: "Not enough Action Points" }, 400);

    s.playerAp -= card.ap;
    let msg = `You played ${card.name}! `;

    if (card.damage) {
      const r = hit(card.damage, s.enemyArmor);
      s.enemyArmor = r.armor;
      s.enemyHp = Math.max(0, s.enemyHp - r.dmg);
      msg += `Dealt ${r.dmg} damage. `;
    }
    if (card.armor)  { s.playerArmor += card.armor; msg += `Gained ${card.armor} armor. `; }
    if (card.heal)   { s.playerHp = Math.min(MAX_HP, s.playerHp + card.heal); msg += `Restored ${card.heal} HP. `; }
    if (card.poison) { s.enemyPoison += card.poison; msg += `Applied ${card.poison} burn/poison. `; }

    s.hand.splice(idx, 1);
    s.log = msg;

    if (s.enemyHp <= 0) {
      const out = await settle(sb, duel, profile, true);
      return json({ ...publicState(s, duel.id, duel.seq + 1, stake), ...(out ?? {}) });
    }

    await sb.from("duel_sessions")
      .update({ state: s, seq: duel.seq + 1, last_action_at: new Date().toISOString() })
      .eq("id", duel.id);
    return json(publicState(s, duel.id, duel.seq + 1, stake));
  }

  if (action === "endTurn") {
    let msg = "";

    // Burn/poison now actually damages, as every card's text promises.
    if (s.enemyPoison > 0) {
      s.enemyHp = Math.max(0, s.enemyHp - s.enemyPoison);
      msg += `Burn/poison dealt ${s.enemyPoison} to ${s.opponent}. `;
      s.enemyPoison = Math.max(0, s.enemyPoison - 2);
    }
    if (s.enemyHp <= 0) {
      s.log = msg;
      const out = await settle(sb, duel, profile, true);
      return json({ ...publicState(s, duel.id, duel.seq + 1, stake), ...(out ?? {}) });
    }

    msg += botTurn(s);

    if (s.playerPoison > 0) {
      s.playerHp = Math.max(0, s.playerHp - s.playerPoison);
      msg += `You took ${s.playerPoison} poison damage. `;
      s.playerPoison = Math.max(0, s.playerPoison - 2);
    }

    s.log = msg;

    if (s.playerHp <= 0) {
      const out = await settle(sb, duel, profile, false);
      return json({ ...publicState(s, duel.id, duel.seq + 1, stake), ...(out ?? {}) });
    }

    s.turn += 1;
    s.playerAp = AP_PER_TURN;
    s.hand = deal(s.deck);

    await sb.from("duel_sessions")
      .update({ state: s, seq: duel.seq + 1, last_action_at: new Date().toISOString() })
      .eq("id", duel.id);
    return json(publicState(s, duel.id, duel.seq + 1, stake));
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
