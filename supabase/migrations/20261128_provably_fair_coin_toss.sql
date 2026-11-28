-- Applied to the live project on 2026-11-28 as provably_fair_coin_toss.
--
-- Who moves first is now decided by a coin a player calls, and the result can
-- be checked afterwards against a hash published before the call. The design,
-- the formula and what it does and does not prove are in
-- supabase/functions/duel/PROVABLY-FAIR.md.
--
-- The secret seed lives in its own table with NO policies. duel_sessions
-- already has no player-read policy - only admins, only finished duels - so
-- the seed would be hidden there too. It gets a second lock anyway: a seed
-- that leaks early makes the whole scheme worthless, and that is not a thing
-- to leave resting on a view never being careless with select *.

create table if not exists public.duel_toss_secrets (
  duel_id     uuid primary key references public.duel_sessions(id) on delete cascade,
  server_seed text not null,
  created_at  timestamptz not null default now()
);

alter table public.duel_toss_secrets enable row level security;
-- deliberately no policies at all: the service role bypasses RLS, everyone
-- else is refused by default.

revoke all on public.duel_toss_secrets from public, anon, authenticated;
grant  all on public.duel_toss_secrets to service_role;

-- What a player is allowed to see, on the duel itself.
alter table public.duel_sessions
  add column if not exists toss_commit      text,
  add column if not exists toss_client_seed text,
  add column if not exists toss_call        text,
  add column if not exists toss_caller      uuid,
  add column if not exists toss_face        text,
  add column if not exists toss_server_seed text,
  add column if not exists toss_called_at   timestamptz,
  add column if not exists toss_auto        boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'duel_sessions_toss_call_chk') then
    alter table public.duel_sessions
      add constraint duel_sessions_toss_call_chk
      check (toss_call is null or toss_call in ('HEADS','TAILS'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'duel_sessions_toss_face_chk') then
    alter table public.duel_sessions
      add constraint duel_sessions_toss_face_chk
      check (toss_face is null or toss_face in ('HEADS','TAILS'));
  end if;
end $$;

comment on table public.duel_toss_secrets is
  'Pre-image of the toss commit. Written at duel creation, read once at reveal. No RLS policies on purpose - service role only.';
comment on column public.duel_sessions.toss_commit is
  'SHA-256 of the server seed, shown to both players before the call.';
comment on column public.duel_sessions.toss_server_seed is
  'The seed itself, written only at the reveal. Null while the toss is pending.';
