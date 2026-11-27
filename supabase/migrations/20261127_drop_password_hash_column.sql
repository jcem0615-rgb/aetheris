-- Applied to the live project on 2026-11-27.
--
-- profiles.password_hash was a leftover from an earlier design: empty on every
-- row, read or written by nothing, while Supabase Auth has always kept the
-- real credential in auth.users where no client role can reach it.
--
-- Dropped rather than left empty because of where it sat. The profiles SELECT
-- policy is `user_id = auth.uid() OR is_admin()`, so an admin can read every
-- column of every player's row. A column named password_hash on that table is
-- an invitation: any future code that populated it would hand every player's
-- credential to every admin, and that mistake would look reasonable while it
-- was being made.
--
-- Guarded: refuses to drop if any row holds a value.
do $$
declare n bigint;
begin
  select count(*) into n from public.profiles
   where password_hash is not null and password_hash <> '';
  if n > 0 then
    raise exception 'refusing to drop profiles.password_hash: % row(s) hold a value', n;
  end if;
end $$;

alter table public.profiles drop column if exists password_hash;
