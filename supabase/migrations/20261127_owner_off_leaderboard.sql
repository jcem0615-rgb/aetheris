-- Applied to the live project on 2026-11-27.
--
-- SUPERSEDED the next day by 20261128_staff_role_not_a_player.sql, which
-- redefines this view to exclude role 'staff' as well. The definition below
-- is no longer what runs in production; it is kept because replaying this
-- directory in order has to pass through it to reach that one.
--
-- The owner was sitting on the public leaderboard among the players. The house
-- does not compete in its own arena.
--
-- coalesce(role, 'player'), not a bare `role <> 'owner'`: role is null for
-- every ordinary player, and in SQL `null <> 'owner'` is NULL rather than
-- true - so the bare form filters out every real player and leaves a
-- leaderboard showing nobody. Proven against sample rows: the naive predicate
-- hides PlayerNull and SecondAdmin, this one keeps them.
--
-- The view stays SECURITY DEFINER deliberately. That is what lets it show all
-- players to everyone; under the querying user's own RLS a player would see
-- only their own row, which is not a leaderboard. It exposes nickname, wins,
-- xp, rank and active_hero and nothing else.
create or replace view public.leaderboard as
  select nickname, wins, xp, rank, active_hero
    from public.profiles
   where approved = true
     and coalesce(frozen, false) = false
     and coalesce(role, 'player') <> 'owner'
   order by xp desc, wins desc
   limit 50;

comment on view public.leaderboard is
  'Public standings. Excludes the owner, unapproved and frozen accounts. SECURITY DEFINER on purpose so every player is visible; exposes only nickname, wins, xp, rank and active_hero.';
