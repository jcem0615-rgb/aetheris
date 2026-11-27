-- Applied to the live project on 2026-11-27.
--
-- Nine tables have RLS enabled with no policies, which already denies every
-- client read and write. The advisor flags that pattern because it is usually
-- an accident; here it is deliberate. Adding policies would GRANT access that
-- does not currently exist - the opposite of a fix.
--
-- What was worth fixing: protection rested on RLS alone while anon and
-- authenticated still held table-level privileges. If RLS were ever disabled
-- on one of these, by accident or by a later migration, the table would be
-- readable immediately. Revoking the grants is a second, independent lock that
-- does not depend on RLS staying switched on.
--
-- No behaviour change. The client references none of these tables, and the
-- code that does use them runs as the service role or SECURITY DEFINER:
--   admin_emails       read by handle_new_user to bootstrap the owner
--   matchmaking_queue  read and written by the duel function
--
-- merchant_settings is the OLD merchant config and still holds gcash_num,
-- gcash_name, maya_num, maya_name and the base64 QRs - a second copy of
-- exactly what was moved out of anon reach in app_settings. Unused by all
-- code. Flagged for dropping, not dropped here: it holds the owner's data and
-- that is their decision.
revoke all on public.admin_emails          from anon, authenticated;
revoke all on public.matchmaking_queue     from anon, authenticated;
revoke all on public.merchant_settings     from anon, authenticated;
revoke all on public.pending_registrations from anon, authenticated;
revoke all on public.players               from anon, authenticated;
revoke all on public.registrations         from anon, authenticated;
revoke all on public.support_chats         from anon, authenticated;
revoke all on public.topups                from anon, authenticated;
revoke all on public.withdrawals           from anon, authenticated;

comment on table public.merchant_settings is
  'SUPERSEDED by app_settings (merchant_config / merchant_private). Still holds a stale copy of the account numbers and names. Unused by all code. Safe to drop.';
