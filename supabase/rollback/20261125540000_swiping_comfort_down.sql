-- Rollback for 20261125540000_swiping_comfort.
-- Drops muted topics + interest tools (mute data is discarded — flagged per
-- Part 0) and restores undo_swipe v1 (no affinity reversal).

drop function if exists public.remove_interest(uuid);
drop function if exists public.get_my_interests(integer);
drop function if exists public.show_more_like_this(uuid);
drop function if exists public.unmute_topic(uuid);
drop function if exists public.mute_topic(uuid, integer);
drop table if exists public.muted_topics;

create or replace function public.undo_swipe(_post_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  _deleted  integer;
  _original integer;
  _balance  bigint;
begin
  delete from public.swipes where user_id = auth.uid() and post_id = _post_id;
  get diagnostics _deleted = row_count;

  if _deleted > 0 then
    select delta into _original
    from public.points_ledger
    where user_id = auth.uid()
      and reason = 'swipe'
      and ref_type = 'swipe'
      and ref_id = _post_id
    order by created_at desc
    limit 1;

    if _original is not null and _original <> 0 then
      perform public._award_to(auth.uid(), -_original, 'swipe_undo', 'swipe', _post_id);
    end if;
  end if;

  select points_balance into _balance from public.profiles where id = auth.uid();
  return _balance;
end;
$$;

delete from public.platform_settings where key in ('swipe_undo_depth', 'affinity_show_more_delta');
