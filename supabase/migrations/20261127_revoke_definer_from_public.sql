-- Applied to the live project on 2026-11-27, after a security advisor run.
--
-- Postgres grants EXECUTE to PUBLIC by default when a function is created, and
-- CREATE OR REPLACE resets that grant. So `revoke execute ... from anon` did
-- nothing while PUBLIC still held it, and every SECURITY DEFINER function in
-- the schema stayed reachable at /rest/v1/rpc/<name> by an unauthenticated
-- caller.
--
-- Same shape as the earlier `revoke select (state)` on duel_sessions, which
-- also did nothing because a table-level grant outranked it. Revoking from the
-- narrow role while the broad one still holds the privilege changes nothing.
--
-- Nothing leaked: collusion_pairs and duel_pace raise 'admin only' as their
-- first statement, verified live against a signed-out caller. This is the
-- layer that should have refused the call before it ever ran.

revoke execute on function public.collusion_pairs(int)     from public, anon;
revoke execute on function public.duel_pace(int, numeric)  from public, anon;
grant  execute on function public.collusion_pairs(int)     to authenticated;
grant  execute on function public.duel_pace(int, numeric)  to authenticated;

-- Trigger functions: only ever invoked by a trigger, never callable over the API.
revoke execute on function public.limit_insert_rate()      from public, anon, authenticated;
revoke execute on function public.limit_pending_requests() from public, anon, authenticated;

-- Server-only, must never be reachable by a client.
revoke execute on function public.apply_wallet_delta(uuid, numeric, text, text)
  from public, anon, authenticated;
revoke execute on function public.owner_earnings(timestamptz, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.expire_stale_duels()     from public, anon, authenticated;
revoke execute on function public.phone_in_use(text)       from public, anon, authenticated;
revoke execute on function public.handle_new_user()        from public, anon, authenticated;
revoke execute on function public.guard_profile_columns()  from public, anon, authenticated;
revoke execute on function public.guard_one_active_duel()  from public, anon, authenticated;

-- is_admin() is the exception and must stay granted. RLS policies on profiles,
-- topup_requests, withdrawal_requests, payment_events, duel_sessions and the
-- storage buckets all call it, and in Postgres the querying role needs EXECUTE
-- on a function referenced in a policy. Revoking it locks every player out of
-- their own rows.
grant execute on function public.is_admin() to authenticated;
