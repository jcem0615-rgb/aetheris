-- Applied to the live project on 2026-11-27, at the owner's request.
--
-- Seven superseded tables dropped. Nothing in the client or any edge function
-- read them; the only remaining reference was a cleanup loop in deletePlayer,
-- updated in the same change.
--
-- merchant_settings was the one that mattered. It was the OLD merchant config
-- and still held gcash_num, gcash_name, maya_num, maya_name and two base64 QR
-- images - a forgotten second copy of exactly the details that had just been
-- moved out of anonymous reach in app_settings. Compared before dropping: its
-- row was last touched 7 November, its names were masked to "J*** C*** M***",
-- and its maya_num held the GCASH number. Strictly staler than what is live,
-- so nothing of value was lost.
--
-- The guard re-counts each of the other six at drop time rather than trusting
-- a count taken a minute earlier, so a table that had somehow gained a row
-- would survive and say so.
do $$
declare t text; n bigint;
begin
  foreach t in array array['pending_registrations','players','registrations',
                           'support_chats','topups','withdrawals']
  loop
    execute format('select count(*) from public.%I', t) into n;
    if n > 0 then
      raise exception 'refusing to drop %: it has % row(s). Look at it first.', t, n;
    end if;
  end loop;
end $$;

drop table if exists public.pending_registrations;
drop table if exists public.players;
drop table if exists public.registrations;
drop table if exists public.support_chats;
drop table if exists public.topups;
drop table if exists public.withdrawals;
drop table if exists public.merchant_settings;
