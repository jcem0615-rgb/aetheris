-- A PvP duel row is shared by two players, so it has no single 'VICTORY': the
-- result records WHICH of them won. The original CHECK allowed only the two
-- bot-duel words, so every PvP settle failed on the constraint - and because
-- the edge function read only `data` and not `error` from that update, the
-- failure was invisible: the winner was told they had won while the write had
-- been rejected, the duel stayed active and the pot was never paid out.
-- expire_stale_duels writes the same marker, so PvP forfeits were broken too.
--
-- Per-player outcomes are still written as VICTORY/DEFEAT into battle_history,
-- which is what the client and the owner's reports actually read.
alter table public.duel_sessions drop constraint if exists duel_sessions_result_check;
alter table public.duel_sessions add constraint duel_sessions_result_check
  check (
    result is null
    or result = any (array['VICTORY','DEFEAT'])
    or result ~ '^WINNER:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
