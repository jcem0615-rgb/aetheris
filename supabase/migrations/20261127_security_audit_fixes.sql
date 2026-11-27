-- Applied to the live project on 2026-11-27, from a security review.

-- 1. duel_sessions.state is a jsonb board holding BOTH sides in full:
--      { a: { hand, deck }, b: { hand, deck }, ... }
--    The SELECT policy was `user_id = auth.uid() OR is_admin()`, and user_id is
--    seat A - so the player in seat A could fetch the raw row from PostgREST
--    and read the opponent's hand and both decks, the whole future draw order.
--    Seat B could not. A decisive cheat in a real-money card game, and
--    asymmetric. The duel function always redacted this; RLS handed it out.
--    The client never reads this table, so removing player access costs nothing.
--    Admins keep access for disputes, but only once a duel is no longer active,
--    so an owner who plays cannot look at a live board either.
--
--    (A `revoke select (state)` does NOT work here: anon and authenticated hold
--    table-level SELECT, which overrides a column-level revoke. The policy is
--    what does the work.)
drop policy if exists "read own duels" on public.duel_sessions;
drop policy if exists duel_sessions_admin_read on public.duel_sessions;
create policy duel_sessions_admin_read on public.duel_sessions
  for select using (public.is_admin() and status <> 'active');

-- 2. app_settings lets anyone, signed in or not, read merchant_config. Players
--    need the QR data from it, but it also carried gcashNum, gcashName,
--    mayaNum and mayaName - so details hidden from the player interface were
--    still served by the API to any unauthenticated caller.
insert into public.app_settings (key, value)
select 'merchant_private',
       jsonb_build_object(
         'gcashNum',  value->>'gcashNum',  'gcashName', value->>'gcashName',
         'mayaNum',   value->>'mayaNum',   'mayaName',  value->>'mayaName')
  from public.app_settings where key = 'merchant_config'
on conflict (key) do update set value = excluded.value;

update public.app_settings
   set value = value - 'gcashNum' - 'gcashName' - 'mayaNum' - 'mayaName'
 where key = 'merchant_config';
