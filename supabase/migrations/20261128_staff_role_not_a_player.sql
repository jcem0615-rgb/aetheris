-- Applied to the live project on 2026-11-28 under the name staff_role_not_a_player.
--
-- A staff admin is not a player. Role 'staff' joins 'owner' in being kept off
-- the public leaderboard and out of the registration revenue figure, because a
-- staff account never pays the registration fee and counting it would invent
-- income that never arrived.
--
-- A player who is ALSO promoted to admin keeps role 'player' and stays visible
-- in both, which is right: they are a customer who happens to help run things.
--
-- These are the full definitions, not a note describing them. They were a
-- comment in 20261128_staff_admin_accounts.sql for a day, which meant a replay
-- of this directory from empty would have rebuilt both objects excluding the
-- owner alone and put staff back on the public leaderboard.
--
-- coalesce(role, 'player'), never a bare `role not in (...)`: role is null for
-- every ordinary player, and in SQL `null not in ('owner','staff')` is NULL
-- rather than true - so the bare form filters out every real player and leaves
-- a leaderboard showing nobody.

create or replace view public.leaderboard as
  select nickname, wins, xp, rank, active_hero
    from public.profiles
   where approved = true
     and coalesce(frozen, false) = false
     and coalesce(role, 'player') not in ('owner', 'staff')
   order by xp desc, wins desc
   limit 50;

comment on view public.leaderboard is
  'Public standings. Excludes the owner, staff admins, unapproved and frozen accounts. SECURITY DEFINER on purpose so every player is visible; exposes only nickname, wins, xp, rank and active_hero.';

create or replace function public.owner_earnings(
  p_from timestamp with time zone default '-infinity'::timestamptz,
  p_to   timestamp with time zone default  'infinity'::timestamptz
)
returns table(
  reg_count bigint, reg_revenue numeric,
  duel_count bigint, duel_rake numeric, duel_volume numeric,
  shop_count bigint, shop_revenue numeric,
  period_revenue numeric,
  deposits_period numeric, withdrawals_period numeric,
  player_balances numeric,
  deposits_all numeric, withdrawals_all numeric, adjustments_all numeric,
  earned_from_wallets numeric,
  cash_expected numeric, discrepancy numeric,
  payouts_pending numeric, payouts_pending_count bigint, payouts_sent numeric
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with
  reg as (
    select count(*) as n, coalesce(sum(registration_fee), 0) as amt
      from public.profiles
     where approved = true
       and coalesce(role, 'player') not in ('owner', 'staff')
       and coalesce(approved_at, created_at) between p_from and p_to
  ),
  duels as (
    select count(*) as n,
           coalesce(sum(stake * 2 - payout), 0) as rake,
           coalesce(sum(stake * 2), 0) as volume
      from public.duel_sessions
     where status = 'settled' and payout is not null
       and settled_at between p_from and p_to
  ),
  shop as (
    select count(*) as n, coalesce(sum(amount), 0) as amt
      from public.wallet_ledger
     where type = 'DEBIT' and reason like 'Purchased %'
       and created_at between p_from and p_to
  ),
  dep as (
    select coalesce(sum(amount) filter (where created_at between p_from and p_to), 0) as period,
           coalesce(sum(amount), 0) as all_time
      from public.wallet_ledger
     where type = 'CREDIT' and reason like 'Top-Up approved%'
  ),
  -- Withdrawals NET of refunds: a refund puts money back in the wallet, so if
  -- it were not subtracted the discrepancy check would report a shortfall that
  -- does not exist.
  wdr as (
    select
      coalesce(sum(case when type = 'DEBIT' then amount else -amount end)
               filter (where created_at between p_from and p_to), 0) as period,
      coalesce(sum(case when type = 'DEBIT' then amount else -amount end), 0) as all_time
      from public.wallet_ledger
     where (type = 'DEBIT'  and reason like 'Withdrawal approved%')
        or (type = 'CREDIT' and reason like 'Withdrawal refunded%')
  ),
  adj as (
    select coalesce(sum(case when type = 'CREDIT' then amount else -amount end), 0) as all_time
      from public.wallet_ledger
     where reason like 'Manual balance adjustment%'
  ),
  payouts as (
    select
      coalesce(sum(amount) filter (where status = 'approved'), 0) as pending,
      count(*)             filter (where status = 'approved')     as pending_n,
      coalesce(sum(amount) filter (where status = 'paid'), 0)     as sent
      from public.withdrawal_requests
  ),
  -- Every wallet, deliberately. The reconciliation identity needs the same set
  -- of balances the ledger moved; narrowing this to players only would break
  -- the discrepancy check rather than tidy it.
  wallets as (
    select coalesce(sum(wallet), 0) as owed from public.profiles
  ),
  earned as (
    select
      coalesce((select sum(amount) from public.wallet_ledger
                 where type = 'DEBIT' and reason like 'Purchased %'), 0)
      + coalesce((select sum(stake * 2 - payout) from public.duel_sessions
                   where status = 'settled' and payout is not null), 0) as amt
  )
  select
    reg.n, reg.amt,
    duels.n, duels.rake, duels.volume,
    shop.n, shop.amt,
    reg.amt + duels.rake + shop.amt as period_revenue,
    dep.period, wdr.period,
    wallets.owed,
    dep.all_time, wdr.all_time, adj.all_time,
    earned.amt,
    dep.all_time - wdr.all_time as cash_expected,
    (dep.all_time - wdr.all_time + adj.all_time) - wallets.owed - earned.amt
      as discrepancy,
    payouts.pending, payouts.pending_n, payouts.sent
  from reg, duels, shop, dep, wdr, adj, payouts, wallets, earned;
$function$;

-- PUBLIC holds EXECUTE on a new function by default, and CREATE OR REPLACE
-- resets the grants, so this has to be re-revoked every time the body changes.
--
-- service_role ALONE, deliberately. 'authenticated' is every signed-in player,
-- and this function returns house revenue, the reconciliation discrepancy and
-- the sum of all player balances. The owner's earnings panel does not call it
-- directly - it goes through the admin-actions edge function, which holds the
-- service key and checks the caller is an admin first. Granting it to
-- authenticated here would hand the whole P&L to anyone with an account.
revoke execute on function public.owner_earnings(timestamptz, timestamptz)
  from public, anon, authenticated;
grant  execute on function public.owner_earnings(timestamptz, timestamptz)
  to service_role;
