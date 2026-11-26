-- guard_one_active_duel already checked both seats (user_id and
-- opponent_user_id), so no player could hold two active duels. What it lacked
-- was serialisation: two concurrent inserts could both read an empty table and
-- both succeed, which in PvP means a player paired into two duels and charged
-- two stakes. The advisory lock makes the check hold rather than merely be
-- likely to - both inserts run this trigger, so the second waits for the first
-- to commit and then sees its row.
create or replace function public.guard_one_active_duel()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
    if new.status <> 'active' then
        return new;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
    if new.opponent_user_id is not null then
        perform pg_advisory_xact_lock(hashtextextended(new.opponent_user_id::text, 0));
    end if;

    if exists (
        select 1 from public.duel_sessions d
         where d.status = 'active'
           and d.id is distinct from new.id
           and (d.user_id          in (new.user_id, new.opponent_user_id)
             or d.opponent_user_id in (new.user_id, new.opponent_user_id))
    ) then
        raise exception 'a player is already in an active duel'
          using errcode = '23505';   -- so the function's existing handling applies
    end if;

    return new;
end;
$function$;
