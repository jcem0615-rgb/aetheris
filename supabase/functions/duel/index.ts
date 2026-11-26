import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// The house's cut of every settled pot, bot duel and PvP alike. A win pays
// `stake * 2 * (1 - PLATFORM_FEE)`, so at 10% that is 1.8x and the arena
// breaks even at a 55.6% player win rate.
//
// This number exists in three other places and they must move together:
//   - public.platform_fee() in Postgres, which expire_stale_duels uses to pay
//     out a PvP duel somebody walked away from
//   - the wager modal and the victory message in index.html, which quote the
//     rate to the player - if those drift the arena misstates its own price
// tools/duel-sim/check-cards.mjs fails if the page and this disagree.
const PLATFORM_FEE = 0.10;
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

// While the bot still has its legs under it, the damage it deals is ROLLED per
// card rather than read straight off the card, so no two battles play out the
// same way. Below BOT_HEALTHY_HP it drops back to exact card values: a wounded
// bot becomes predictable, which is what lets a player close out a duel on
// plan rather than on luck.
//
// The roll is a multiplier on the card's OWN damage, not a flat damage band,
// and the width is not a matter of taste. Both were measured against
// tools/duel-sim with a no-jitter control, 8000 duels per population, three
// runs each (the simulator's own run-to-run noise is about 3 points, so a
// single run proves nothing):
//
//   flat 25-40 for every hero   player win 61-81%, house -16.6% / -54.1%
//   the same band scaled by     player win 44-69%, house +15.8% / -30.9%
//     hero tier                 and 4.4% of duels lost before the player moved
//   x0.85-1.25 per card         house +7.3% / +1.7%  (shop margin down ~2.4)
//   x0.90-1.10 per card         house +7.1% / +3.5%  (control: +6.3% / +4.1%)
//
// A flat band cannot work: 25-40 is about right for Pyra, whose strike does
// 26, and guts Astral Archmage, whose strike does 60 and whose shop skills do
// 142. Scaling the band per hero does not fix it either, because the bot also
// holds shop cards no per-hero anchor knows about. A multiplier scales with
// every card the bot can ever hold, and +/-10% is the widest setting that
// leaves the house margin where it was.
//
// This is the BOT's trait and the bot's alone. A player's own card always
// deals exactly what the card says, in a bot duel and in PvP, and PvP rolls
// nothing for either seat - player against player is a straight fight.
//
// Armor is deliberately NOT rolled. Armor subtracts a FLAT amount, so moving
// it swings the result far more than the same percentage on damage: every
// armor band tried, in either direction and as narrow as +/-5%, cost the
// shop-skill population about two points of margin.
const BOT_HEALTHY_HP = 60;
const BOT_DMG_LO = 0.90, BOT_DMG_HI = 1.10;

// rnd is the crypto source already used for dealing; 1000 steps is far finer
// than any damage number here, so the spread is effectively continuous.
const rollFactor = (lo: number, hi: number) => lo + (hi - lo) * (rnd(1001) / 1000);

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
function botTurn(s: State, apBudget: number = AP_PER_TURN, opening = false): string {
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

    // Re-checked per card: a heal can lift the bot back over the line
    // mid-turn, and the cards after it should follow suit.
    const healthy = s.enemyHp > BOT_HEALTHY_HP;

    if (c.damage) {
      const dealt = healthy
        ? Math.max(1, Math.round(c.damage * rollFactor(BOT_DMG_LO,
            opening ? 1.0 : BOT_DMG_HI)))
        : c.damage;
      const r = hit(dealt, s.playerArmor);
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

// ---------------------------------------------------------------- PvP ----
// A PvP duel is stored from nobody's point of view: two symmetric seats, and
// whose turn it is. Each player is then shown the board from their own seat
// using the SAME field names a bot duel sends, so the page renders either kind
// without knowing the difference. A player is only ever sent their own hand.
//
// Nothing here rolls a damage number. Both seats deal exactly what the card
// says: player against player is a straight fight, and the house takes its cut
// from the pot rather than from the odds.
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

// Pays the winner out of BOTH stakes, less the platform fee: the same 1.8x a
// bot duel pays, except the losing stake is a real player's rather than the
// house's. Settles once, by conditional update, however many clients ask.
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
    .select("user_id, email, nickname, wallet, wins, xp, approved, frozen, active_hero, unlocked_heroes, unlocked_skills")
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

    // A player picks one hero with their registration fee. Without this the
    // `?? "pyra"` below would quietly hand a free hero to anyone who had not
    // claimed one, which is the hero the fee is supposed to buy.
    const roster: string[] = Array.isArray(profile.unlocked_heroes) ? profile.unlocked_heroes : [];
    if (roster.length === 0 || !profile.active_hero) {
      return json({ error: "Choose your champion before entering the arena" }, 403);
    }
    if (!roster.includes(profile.active_hero)) {
      return json({ error: "That hero is not on your roster" }, 403);
    }

    const heroId = profile.active_hero;
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

    // Oldest waiting player at the same stake, never myself.
    const { data: waiting } = await sb.from("matchmaking_queue")
      .select("id, user_id, player_nickname, hero")
      .eq("status", "waiting").eq("stake", stake).neq("user_id", uid)
      .order("created_at", { ascending: true }).limit(1).maybeSingle();

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
      stake, hero: myHero, status: "waiting",
    }]);
    return json({ waiting: true, matched: false });
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

  // ---- a PvP duel runs its own turn logic and never touches botTurn --------
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

  const s: State = duel.state as State;

  // Commits the wager and reveals the board. seq moves 0 -> 1, which is what
  // cancel and the stale-duel sweep read as "this duel has begun".
  if (action === "start") {
    if (duel.seq === 0) {
      // Initiative was decided at escrow. The player used to open every duel,
      // and since most heroes can spend three AP for more than 100 damage, the
      // better opening hand simply won before the opponent acted at all.
      if (s.botFirst) {
        const opening = botTurn(s, OPENING_AP, true);
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

    // The player's own card always deals exactly what the card says. Only the
    // bot's output is rolled, and only in botTurn.
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
