-- Applied to the live project on 2026-11-27.
--
-- Rate limits as triggers, not as edge-function code. Triggers fire for the
-- service role too, so a limit here covers both a player posting straight to
-- PostgREST and an edge function acting on their behalf - and it needs no
-- redeploy of the combat engine to add a counter.
--
-- The gap this closes first is not bots. Nothing stopped a player creating
-- unlimited pending top-up or cash-out requests: the insert policy checks the
-- owner, the status and the minimum, and nothing else. A few thousand pending
-- rows would bury the owner's queue and hide the real requests.
--
--   topup_requests        5 pending at once, 20 an hour
--   withdrawal_requests   3 pending at once, 10 an hour
--   duel_sessions         100 an hour   (one every 36s sustained - no person)
--   matchmaking_queue     60 per 10 min (searching repeatedly is normal)
--
-- Safe on duel_sessions specifically because findMatch inserts the duel BEFORE
-- debiting either stake, and already handles a failed insert by releasing the
-- queue row and asking the client to retry. No money has moved at that point.
--
-- Full definitions are in the migration named rate_limits_as_triggers.

-- auth_config holds the Turnstile SITE key, which the registration form needs
-- before anyone is signed in. A site key is public by design. The SECRET key
-- is never stored here - it goes in the Supabase dashboard, where Supabase
-- Auth verifies the token server-side.
insert into public.app_settings (key, value)
values ('auth_config', jsonb_build_object('turnstileSiteKey', ''))
on conflict (key) do nothing;

drop policy if exists "anyone reads merchant config" on public.app_settings;
create policy "anyone reads public config" on public.app_settings
  for select using (key in ('merchant_config', 'auth_config'));
