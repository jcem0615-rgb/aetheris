import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// The house's cut of every settled pot. A win pays
// `stake * 2 * (1 - PLATFORM_FEE)`, so at 10% that is 1.8x and the arena
// breaks even at a 55.6% player win rate.
//
// This number exists in three other places and they must move together:
//   - public.platform_fee() in Postgres, which expire_stale_duels uses to pay
//     out a duel somebody walked away from
//   - the wager modal and the victory message in index.html, which quote the
//     rate to the player - if those drift the arena misstates its own price
// tools/duel-sim/check-cards.mjs fails if the page and this disagree.
const PLATFORM_FEE = 0.10;
const ALLOWED_STAKES = [50, 100, 200, 500, 1000];
const MAX_HP = 150;
const AP_PER_TURN = 3;
const HAND_SIZE = 4;

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
//
// The paid skills are generated from those same base numbers, so the shop
// ladder cannot invert and a paid skill is never a downgrade. Their ceiling is
// the 150 HP pool: base burst already reaches 137 at the top of the ladder, so
// a 3-AP paid skill can add only a few points of damage before it one-shots
// from full health. Four of them sit pinned at that cap.
const CARD_TABLE = "pyra-1,1,26,0,0,0,FLAME DART|pyra-2,1,0,14,0,0,FIRE SHIELD|pyra-3,2,33,0,0,6,SCORCH|pyra-4,2,22,0,14,0,BLAZING HEAL|sylph-1,1,28,0,0,0,GALE SLASH|sylph-2,1,0,15,0,0,WIND STEP|sylph-3,2,35,0,0,6,GALE ARROW|sylph-4,2,24,0,15,0,WIND MEND|valen-1,1,31,0,0,0,SHIELD BASH|valen-2,1,0,17,0,0,IRON BASTION|valen-3,2,39,0,0,0,HEAVY SLAM|valen-4,2,31,21,0,0,FORTIFY|nyx-1,1,33,0,0,0,SHADOW STAB|nyx-2,1,0,18,0,0,SMOKE CLOAK|nyx-3,2,42,0,0,7,VENOM BLADE|nyx-4,2,29,0,18,0,LIFE SIPHON|storm-1,1,36,0,0,0,SPARK STRIKE|storm-2,1,0,20,0,0,STATIC GUARD|storm-3,2,46,0,0,0,LIGHTNING BOLT|storm-4,2,36,0,33,0,ELECTRO MEND|titan-1,1,40,0,0,0,STONE SMASH|titan-2,1,0,22,0,0,TECTONIC BLOCK|titan-3,2,51,0,0,0,EARTHQUAKE|titan-4,2,40,28,0,0,TITAN MEND|chrono-1,1,44,0,0,0,TIME SLASH|chrono-2,1,0,24,0,0,TEMPORAL WARD|chrono-3,2,56,0,0,0,TIME WARP|chrono-4,2,44,0,39,0,HOURGLASS HEAL|valkyrie-1,1,48,0,0,0,HOLY SPEAR|valkyrie-2,1,0,26,0,0,RADIANT SHIELD|valkyrie-3,2,61,0,0,0,CELESTIAL STRIKE|valkyrie-4,2,48,0,43,0,DIVINE MEND|void-1,1,52,0,0,0,DARK BOLT|void-2,1,0,28,0,0,SOUL BARRIER|void-3,2,66,0,0,12,PLAGUE WAVE|void-4,2,45,0,28,0,ABYSSAL DRAIN|berserk-1,1,57,0,0,0,BLOOD AXE|berserk-2,1,0,31,0,0,FRENZIED BLOCK|berserk-3,2,72,0,0,0,BLOODY RAMPAGE|berserk-4,2,57,0,51,0,BLOOD FEAST|astral-1,1,60,0,0,0,STELLAR RAY|astral-2,1,0,32,0,0,COSMIC BARRIER|astral-3,2,77,0,0,0,SUPERNOVA|astral-4,2,60,0,54,0,ASTRAL MEND|shop-pyra-2,2,42,0,0,6,INFERNAL HELLFIRE|shop-pyra-3,3,77,0,0,19,SOLAR SUPERNOVA|shop-sylph-2,2,45,0,0,6,HURRICANE BARRAGE|shop-sylph-3,3,83,0,0,20,HURRICANE APOCALYPSE|shop-valen-2,2,50,8,0,0,AEGIS FORTRESS|shop-valen-3,3,92,27,0,0,DIVINE INVINCIBILITY|shop-nyx-2,2,54,0,0,7,SHADOW ASSASSINATION|shop-nyx-3,3,98,0,0,24,ABSOLUTE SHADOW ECLIPSE|shop-storm-2,2,59,0,0,8,THUNDER GODS WRATH|shop-storm-3,3,108,0,0,26,ZEUS THUNDERSTORM|shop-titan-2,2,65,11,0,0,CONTINENTAL CRUSH|shop-titan-3,3,119,35,0,0,WORLD SHATTERING METEOR|shop-chrono-2,2,72,0,12,0,TEMPORAL REWIND|shop-chrono-3,3,131,0,40,0,ETERNAL TIME COLLAPSE|shop-valkyrie-2,2,78,0,13,0,DIVINE JUDGMENT|shop-valkyrie-3,3,142,0,44,0,HEAVENLY RAGNAROK|shop-void-2,2,82,0,15,0,SOUL HARVEST|shop-void-3,3,142,0,0,38,VOID REALM ANNIHILATION|shop-berserk-2,2,82,0,16,0,APOCALYPSE FRENZY|shop-berserk-3,3,142,0,52,0,RAGING BLOOD GOD RAMPAGE|shop-astral-2,2,82,0,17,0,GALAXY COLLAPSE|shop-astral-3,3,142,0,55,0,BIG BANG UNIVERSE STRIKE";

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

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const db = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Server-side RNG: the client cannot predict or steer a shuffle.
function rnd(n: number) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
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
  // Count the cards BEFORE drawing. The bound used to be re-evaluated every
  // pass against a pool that shrinks as cards come out of it, so a four-card
  // deck dealt two and a six-card deck dealt three. Every hand in the game,
  // the opponent's included, had been short since server-side combat shipped.
  const draw = Math.min(HAND_SIZE, pool.length);
  const hand: string[] = [];
  for (let i = 0; i < draw; i++) {
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

// How strong a player is, for pairing: their rung on the hero ladder plus what
// they have bought for that hero.
//
// This matters now in a way it did not before. The house bot was always drawn
// from within one rung of the player (the old matchOpponentHero). Between two
// real players nothing enforced that: the queue paired on STAKE ALONE, so a
// maxed Astral Archmage holding two 142-damage shop skills could be matched
// against a starter Pyra for the same money. That is not a duel, it is a
// transfer, and it is the fastest way to lose every new player you register.
//
// The weights are measured, not guessed. A shop skill was first counted as 1
// against a rung's 2, on the reasoning that a tier should outweigh a purchase.
// tools/duel-sim/fairness.mts showed that is badly wrong at the bottom of the
// ladder, where a paid skill roughly doubles your damage - Pyra strikes for 26
// and her shop skills do 42 and 77. At that weighting valen+0 and valen+2 fell
// inside the same bracket and the buyer won 70.6% of the time. At 3 every
// pairing the matchmaker will make sits inside 40-60%.
const SHOP_SKILL_WEIGHT = 3;

function powerOf(heroId: string, owned: Record<string, boolean>): number {
  const rung = Math.max(0, HERO_LADDER.indexOf(heroId));
  const bought = (HERO_SHOP[heroId] ?? []).filter((id) => owned && owned[id]).length;
  return rung * 2 + bought * SHOP_SKILL_WEIGHT;
}

// How far from your own power you will accept, by how long you have waited.
// Someone at the very top or bottom of the ladder has few true peers, so a
// fixed bracket would leave them queuing forever; after two minutes they take
// anyone, because by then the alternative is no duel at all.
function toleranceFor(waitedMs: number): number {
  const secs = Math.max(0, waitedMs) / 1000;
  if (secs >= 120) return 99;
  return 2 + Math.floor(secs / 20);
}

// ---------------------------------------------------------------- PvP ----
// Every duel is player against player. The house opponent was removed: it
// decided outcomes with the house's own money on the table, which is a risk no
// rake is worth. The arena now earns from the registration fee and the cut it
// takes from each pot, and never from whether a player wins.
//
// A duel is stored from nobody's point of view: two symmetric seats, and whose
// turn it is. Each player is shown the board from their own seat, and is only
// ever sent their own hand.
//
// Nothing here rolls a damage number. Both seats deal exactly what the card
// says - a straight fight, with the house's cut coming out of the pot rather
// than out of the odds.
interface PvpSide {
  userId: string; nick: string; heroId: string;
  hp: number; armor: number; ap: number; poison: number;
  deck: string[]; hand: string[];
}
interface PvpState {
  mode: "pvp";
  a: PvpSide; b: PvpSide;
  turn: "a" | "b";
  turnNo: number;
  log: string;
}

const seatOf = (s: PvpState, uid: string): "a" | "b" | null =>
  s.a.userId === uid ? "a" : s.b.userId === uid ? "b" : null;

// The final board plus the viewer's own outcome, read back from the row. Both
// the loser polling a duel that ended on the opponent's turn and the request
// that loses a settle race need exactly this, so it lives in one place.
// deno-lint-ignore no-explicit-any
async function settledPvpView(sb: any, duelId: string, uid: string) {
  const { data: row } = await sb.from("duel_sessions")
    .select("id, stake, result, payout, seq, state").eq("id", duelId).maybeSingle();
  if (!row) return null;
  const fin = row.state as PvpState;
  if (!seatOf(fin, uid)) return null;
  const iWon = String(row.result ?? "").replace("WINNER:", "") === uid;
  const paid = Number(row.payout ?? 0);
  const st = Number(row.stake);
  return {
    ...pvpPublicState(fin, row.id, row.seq, st, uid),
    finished: true,
    result: iWon ? "VICTORY" : "DEFEAT",
    byOpponent: !iWon,
    payout: iWon ? paid : 0,
    netGain: iWon ? paid - st : -st,
  };
}

function pvpPublicState(s: PvpState, duelId: string, seq: number, stake: number, uid: string) {
  const seat = seatOf(s, uid);
  const me  = seat === "b" ? s.b : s.a;
  const foe = seat === "b" ? s.a : s.b;
  return {
    duelId, seq, stake, mode: "pvp" as const,
    heroId: me.heroId, enemyHeroId: foe.heroId, opponent: foe.nick,
    playerHp: me.hp, playerMaxHp: MAX_HP, playerArmor: me.armor,
    playerAp: me.ap, playerPoison: me.poison,
    enemyHp: foe.hp, enemyMaxHp: MAX_HP, enemyArmor: foe.armor,
    enemyPoison: foe.poison,
    hand: me.hand,                 // never the opponent's
    enemyHandCount: foe.hand.length,
    turn: s.turnNo, log: s.log,
    myTurn: seat === s.turn,
  };
}

function newSide(userId: string, nick: string, heroId: string, owned: Record<string, boolean>): PvpSide {
  const deck = deckFor(heroId, owned);
  return { userId, nick, heroId, hp: MAX_HP, armor: 0, ap: AP_PER_TURN, poison: 0,
           deck, hand: deal(deck) };
}

// Pays the winner out of BOTH stakes, less the platform fee: 1.8x the stake.
// Every peso paid out comes from the other player, never from the house.
// Settles once, by conditional update, however many clients ask.
// deno-lint-ignore no-explicit-any
async function settlePvp(sb: any, duel: any, winnerSeat: "a" | "b", reason: string) {
  const s = duel.state as PvpState;
  const stake = Number(duel.stake);
  const payout = stake * 2 * (1 - PLATFORM_FEE);
  const winner = winnerSeat === "a" ? s.a : s.b;
  const loser  = winnerSeat === "a" ? s.b : s.a;

  const { data: upd, error: updErr } = await sb.from("duel_sessions")
    .update({ status: "settled", result: `WINNER:${winner.userId}`, payout,
              settled_at: new Date().toISOString(), state: s })
    .eq("id", duel.id).eq("status", "active").select("id");

  // A write that FAILED must never be reported to the player as a win: that is
  // how a duel ends with both stakes taken and nobody paid. Only "no rows" is
  // benign - it means another request settled this duel a moment earlier.
  if (updErr) throw new Error(`PvP settle write failed: ${updErr.message}`);
  if (!upd?.length) return null;

  const { data: bal } = await sb.rpc("apply_wallet_delta", {
    p_user_id: winner.userId, p_delta: payout,
    p_reason: `Ranked Duel won vs ${loser.nick} (${reason})`, p_type: "CREDIT",
  });

  const { data: wp } = await sb.from("profiles")
    .select("wins, xp").eq("user_id", winner.userId).maybeSingle();
  await sb.from("profiles")
    .update({ wins: Number(wp?.wins ?? 0) + 1, xp: Number(wp?.xp ?? 0) + 100 })
    .eq("user_id", winner.userId);

  const now = new Date();
  await sb.from("battle_history").insert([
    { user_id: winner.userId, player_name: winner.nick, opponent: loser.nick,
      result: "VICTORY", wager: stake, bet: stake, post_balance: bal?.[0]?.post_balance,
      date: now.toISOString().split("T")[0], time: now.toTimeString().slice(0, 8) },
    { user_id: loser.userId, player_name: loser.nick, opponent: winner.nick,
      result: "DEFEAT", wager: stake, bet: stake,
      date: now.toISOString().split("T")[0], time: now.toTimeString().slice(0, 8) },
  ]);

  return { winnerUserId: winner.userId, payout, stake };
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
    .select("user_id, email, nickname, wallet, wins, xp, approved, frozen, active_hero, unlocked_heroes, unlocked_skills")
    .eq("user_id", uid).maybeSingle();

  if (!profile) return json({ error: "No profile" }, 403);
  if (profile.frozen) return json({ error: "Account is frozen" }, 403);
  if (!profile.approved) return json({ error: "Account is not approved yet" }, 403);

  // ---- PvP matchmaking ----------------------------------------------------
  // Nothing is staked while a player waits: the two debits happen at the
  // moment a pair is actually formed, so a long wait never locks up money.
  if (action === "findMatch" || action === "pollMatch" || action === "cancelSearch") {
    if (action === "cancelSearch") {
      await sb.from("matchmaking_queue").delete().eq("user_id", uid).eq("status", "waiting");
      return json({ cancelled: true });
    }

    if (action === "pollMatch") {
      const { data: mine } = await sb.from("matchmaking_queue")
        .select("status, duel_id").eq("user_id", uid).maybeSingle();
      if (!mine) return json({ waiting: false, matched: false });
      if (mine.status === "matched" && mine.duel_id) {
        await sb.from("matchmaking_queue").delete().eq("user_id", uid);
        return json({ matched: true, duelId: mine.duel_id });
      }
      return json({ waiting: true, matched: false });
    }

    // ---- findMatch
    const stake = Number(body.stake);
    if (!ALLOWED_STAKES.includes(stake)) return json({ error: "Invalid stake" }, 400);
    if (Number(profile.wallet) < stake) return json({ error: "Insufficient balance" }, 400);

    const myRoster: string[] = Array.isArray(profile.unlocked_heroes) ? profile.unlocked_heroes : [];
    if (myRoster.length === 0 || !profile.active_hero || !myRoster.includes(profile.active_hero)) {
      return json({ error: "Choose your champion before entering the arena" }, 403);
    }

    await sb.rpc("expire_stale_duels");

    const myHero = profile.active_hero;
    const myNick = profile.nickname ?? "Challenger";
    const owned = (profile.unlocked_skills ?? {}) as Record<string, boolean>;

    const myPower = powerOf(myHero, owned);

    // Everyone waiting at this stake, oldest first, and then the first one
    // close enough in power to be a fair fight. The bracket used is the WIDER
    // of the two: whoever has waited longer has already accepted a rougher
    // match, and it would be unfair to make them keep waiting because the
    // player who just arrived is still being fussy.
    const { data: pool } = await sb.from("matchmaking_queue")
      .select("id, user_id, player_nickname, hero, power, created_at")
      .eq("status", "waiting").eq("stake", stake).neq("user_id", uid)
      .order("created_at", { ascending: true }).limit(20);

    const now = Date.now();
    const waiting = (pool ?? []).find((row) => {
      const theirWait = now - new Date(row.created_at as string).getTime();
      const bracket = Math.max(toleranceFor(0), toleranceFor(theirWait));
      return Math.abs(Number(row.power ?? 0) - myPower) <= bracket;
    });

    if (waiting?.user_id) {
      // Claim them. The conditional update means only one caller can win this
      // row, so two players arriving at once cannot both pair with a third.
      const { data: claimed } = await sb.from("matchmaking_queue")
        .update({ status: "matching" })
        .eq("id", waiting.id).eq("status", "waiting").select("id");

      if (claimed?.length) {
        const { data: foe } = await sb.from("profiles")
          .select("user_id, nickname, wallet, active_hero, unlocked_skills")
          .eq("user_id", waiting.user_id).maybeSingle();

        const foeOwned = (foe?.unlocked_skills ?? {}) as Record<string, boolean>;
        const foeHero = foe?.active_hero ?? waiting.hero ?? "pyra";

        // They may have spent their balance while waiting. Drop them and let
        // the caller search again rather than pairing into a duel that cannot
        // be funded.
        if (!foe || Number(foe.wallet) < stake) {
          await sb.from("matchmaking_queue").delete().eq("id", waiting.id);
          return json({ waiting: false, retry: true });
        }

        const iAmA = rnd(2) === 0;
        const meSide  = newSide(uid, myNick, myHero, owned);
        const foeSide = newSide(foe.user_id, foe.nickname ?? "Challenger", foeHero, foeOwned);
        const pvp: PvpState = {
          mode: "pvp",
          a: iAmA ? meSide : foeSide,
          b: iAmA ? foeSide : meSide,
          turn: rnd(2) === 0 ? "a" : "b",
          turnNo: 1,
          log: "Opponent found. The duel begins.",
        };

        // Insert first: the one-active-duel trigger is what stops either side
        // being pulled into two duels at once, and it is cheaper to undo an
        // insert than to refund two debits.
        const { data: duelRow, error: duelErr } = await sb.from("duel_sessions")
          .insert([{ user_id: pvp.a.userId, opponent_user_id: pvp.b.userId,
                     mode: "pvp", stake, opponent: foe.nickname,
                     turn_user_id: pvp.turn === "a" ? pvp.a.userId : pvp.b.userId,
                     state: pvp, seq: 1 }])
          .select("id").single();

        if (duelErr || !duelRow) {
          await sb.from("matchmaking_queue").delete().eq("id", waiting.id);
          return json({ waiting: false, retry: true });
        }

        const debit = async (who: string, nick: string) => await sb.rpc("apply_wallet_delta", {
          p_user_id: who, p_delta: -stake,
          p_reason: `Ranked Duel wager escrowed (\u20b1${stake} vs ${nick})`, p_type: "DEBIT",
        });

        const { error: e1 } = await debit(foe.user_id, myNick);
        if (e1) {
          await sb.from("duel_sessions").delete().eq("id", duelRow.id);
          await sb.from("matchmaking_queue").delete().eq("id", waiting.id);
          return json({ waiting: false, retry: true });
        }
        const { data: myBal, error: e2 } = await debit(uid, foe.nickname ?? "Challenger");
        if (e2) {
          // Put the opponent's stake back and leave them queued to try again.
          await sb.rpc("apply_wallet_delta", {
            p_user_id: foe.user_id, p_delta: stake,
            p_reason: "Ranked Duel wager refunded (pairing failed)", p_type: "CREDIT",
          });
          await sb.from("duel_sessions").delete().eq("id", duelRow.id);
          await sb.from("matchmaking_queue").update({ status: "waiting" }).eq("id", waiting.id);
          return json({ error: e2.message }, 400);
        }

        // Stamp their row so their next poll finds the duel.
        await sb.from("matchmaking_queue")
          .update({ status: "matched", duel_id: duelRow.id, opponent_nickname: myNick })
          .eq("id", waiting.id);
        await sb.from("matchmaking_queue").delete().eq("user_id", uid);

        return json({ matched: true, duelId: duelRow.id, stake,
                      opponent: foe.nickname, balance: myBal?.[0]?.post_balance });
      }
    }

    // Nobody to pair with: take a place in the queue.
    await sb.from("matchmaking_queue").delete().eq("user_id", uid);
    await sb.from("matchmaking_queue").insert([{
      user_id: uid, player_email: profile.email, player_nickname: myNick,
      stake, hero: myHero, power: myPower, status: "waiting",
    }]);
    return json({ waiting: true, matched: false, power: myPower });
  }

  // Anyone still running the old page will ask for a house duel after its
  // twenty-second search. Without this the request falls through to the duel
  // lookup below, finds no duelId and comes back "Duel not found", which tells
  // them nothing. Say what actually happened.
  if (action === "escrow") {
    return json({ error: "House duels have been retired - every duel is now against " +
                         "another player. Please refresh the page to continue." }, 410);
  }

  // Everything past this point needs a duel to act on, so an action that is
  // not one of these is a bad request, not a missing duel.
  if (!["start", "getState", "surrender", "playCard", "endTurn"].includes(action)) {
    return json({ error: `Unknown action: ${action}` }, 400);
  }

  const { data: duel } = await sb.from("duel_sessions")
    .select("id, stake, status, opponent, state, seq, mode, opponent_user_id, turn_user_id")
    .eq("id", String(body.duelId ?? ""))
    .or(`user_id.eq.${uid},opponent_user_id.eq.${uid}`).maybeSingle();

  if (!duel) return json({ error: "Duel not found" }, 404);

  // A settled PvP duel still has one player waiting on it: the loser is
  // polling getState when their opponent lands the killing blow, and the duel
  // is no longer active by the time that poll arrives. Hand them the final
  // board and the result instead of "already finished", or they would sit in
  // the arena forever never learning they lost.
  if (duel.status !== "active") {
    if (duel.mode === "pvp" && (action === "getState" || action === "start")) {
      const view = await settledPvpView(sb, duel.id, uid);
      if (view) return json(view);
      return json({ error: "Not your duel" }, 403);
    }
    return json({ error: "Duel already finished" }, 409);
  }

  const stake = Number(duel.stake);

  if (duel.mode === "pvp") {
    const ps = duel.state as PvpState;
    const seat = seatOf(ps, uid);
    if (!seat) return json({ error: "Not your duel" }, 403);
    const me  = seat === "a" ? ps.a : ps.b;
    const foe = seat === "a" ? ps.b : ps.a;
    const foeSeat: "a" | "b" = seat === "a" ? "b" : "a";

    const sendState = (extra: Record<string, unknown> = {}) =>
      json({ ...pvpPublicState(ps, duel.id, duel.seq, stake, uid), ...extra });

    if (action === "start" || action === "getState") return sendState();

    if (action === "surrender") {
      const out = await settlePvp(sb, duel, foeSeat, "opponent surrendered");
      if (!out) {
        const view = await settledPvpView(sb, duel.id, uid);
        return view ? json(view) : json({ error: "Duel already finished" }, 409);
      }
      return sendState({ finished: true, result: "DEFEAT", payout: 0, netGain: -stake });
    }

    // Acting out of turn is refused outright: the board only ever moves on
    // the move of whoever the server says is up.
    if (action === "playCard" || action === "endTurn") {
      if (ps.turn !== seat) return json({ error: "It is not your turn" }, 409);

      const clientSeq = Number(body.seq ?? -1);
      if (clientSeq !== duel.seq) {
        return json({ error: "Out of sync",
                      resync: pvpPublicState(ps, duel.id, duel.seq, stake, uid) }, 409);
      }
    }

    if (action === "playCard") {
      const idx = Number(body.handIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= me.hand.length) {
        return json({ error: "No such card in hand" }, 400);
      }
      const card = CARDS[me.hand[idx]];
      if (!card) return json({ error: "Unknown card" }, 400);
      if (me.ap < card.ap) return json({ error: "Not enough Action Points" }, 400);

      me.ap -= card.ap;
      let msg = `${me.nick} played ${card.name}! `;
      if (card.damage) {
        const r = hit(card.damage, foe.armor);
        foe.armor = r.armor;
        foe.hp = Math.max(0, foe.hp - r.dmg);
        msg += `Dealt ${r.dmg} damage. `;
      }
      if (card.armor)  { me.armor += card.armor; msg += `Gained ${card.armor} armor. `; }
      if (card.heal)   { me.hp = Math.min(MAX_HP, me.hp + card.heal); msg += `Restored ${card.heal} HP. `; }
      if (card.poison) { foe.poison += card.poison; msg += `Applied ${card.poison} burn/poison. `; }
      me.hand.splice(idx, 1);
      ps.log = msg;

      if (foe.hp <= 0) {
        const out = await settlePvp(sb, duel, seat, "opponent defeated");
        if (!out) {
          // Lost the race: whoever settled it first decided the outcome.
          const view = await settledPvpView(sb, duel.id, uid);
          return view ? json(view) : json({ error: "Duel already finished" }, 409);
        }
        return sendState({ finished: true, result: "VICTORY",
                           payout: out.payout, netGain: out.payout - stake });
      }

      await sb.from("duel_sessions")
        .update({ state: ps, seq: duel.seq + 1, last_action_at: new Date().toISOString() })
        .eq("id", duel.id);
      return json(pvpPublicState(ps, duel.id, duel.seq + 1, stake, uid));
    }

    if (action === "endTurn") {
      let msg = "";
      // The burn I put on them lands as I hand the turn over; theirs lands
      // when they hand it back, so each side's poison ticks once a round.
      if (foe.poison > 0) {
        foe.hp = Math.max(0, foe.hp - foe.poison);
        msg += `Burn/poison dealt ${foe.poison} to ${foe.nick}. `;
        foe.poison = Math.max(0, foe.poison - 2);
      }
      if (foe.hp <= 0) {
        ps.log = msg;
        const out = await settlePvp(sb, duel, seat, "burn finished them");
        if (!out) {
          // Lost the race: whoever settled it first decided the outcome.
          const view = await settledPvpView(sb, duel.id, uid);
          return view ? json(view) : json({ error: "Duel already finished" }, 409);
        }
        return sendState({ finished: true, result: "VICTORY",
                           payout: out.payout, netGain: out.payout - stake });
      }

      ps.turn = foeSeat;
      ps.turnNo += 1;
      foe.ap = AP_PER_TURN;
      foe.hand = deal(foe.deck);
      ps.log = `${msg}${me.nick} ended their turn. ${foe.nick} is up.`;

      await sb.from("duel_sessions")
        .update({ state: ps, seq: duel.seq + 1,
                  turn_user_id: foe.userId,
                  last_action_at: new Date().toISOString() })
        .eq("id", duel.id);
      return json(pvpPublicState(ps, duel.id, duel.seq + 1, stake, uid));
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
