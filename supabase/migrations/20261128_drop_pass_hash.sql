-- Applied to the live project on 2026-11-28.
--
-- profiles.pass_hash, a leftover from the pre-Supabase-Auth design. Nothing
-- read or wrote it, but unlike the empty password_hash column dropped the day
-- before, this one HELD A VALUE: a 64-character lowercase hex string, i.e. an
-- unsalted SHA-256.
--
-- Not plaintext, but close to it in practice: unsalted SHA-256 of a
-- human-chosen password falls to a rainbow table or a GPU in seconds. It sat
-- on the one table whose SELECT policy is `user_id = auth.uid() OR is_admin()`,
-- readable by every admin including any future second admin.
--
-- The real credential has always been bcrypt in auth.users, which no client
-- role can reach. This was a redundant, weaker second copy. The value was not
-- read, only dropped.
--
-- The earlier audit missed it: it searched for %password%, %passwd%, %secret%
-- and %pass. 'pass_hash' matches none of those. The guard below now checks by
-- substring.
alter table public.profiles drop column if exists pass_hash;

do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public'
     and (column_name ilike '%pass%' or column_name ilike '%hash%'
          or column_name ilike '%secret%' or column_name ilike '%token%'
          or column_name ilike '%credential%');
  if n > 0 then
    raise exception 'a credential-shaped column still exists in public: % found', n;
  end if;
end $$;
