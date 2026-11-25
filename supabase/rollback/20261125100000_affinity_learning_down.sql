-- Rollback for 20261125100000_affinity_learning.
-- Restores record_swipe to the 20261124100000 version (gap gate + trust gate,
-- no affinity block) and removes the affinity settings. Weights already
-- nudged in user_tags are left as they are (data, not schema).

set search_path = public, extensions;

create or replace function public.record_swipe(_post_id uuid, _direction text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _inserted integer;
  _balance  bigint;
  _last     timestamptz;
  _dwell_ok boolean;
  _trusted  boolean;
  _lc       integer;
  _upto     integer;
  _owner    uuid;
  _buckets  integer;
begin
  if _direction not in ('left', 'right') then
    raise exception 'record_swipe: direction must be left or right';
  end if;

  select max(created_at) into _last from public.swipes where user_id = auth.uid();
  _dwell_ok := (_last is null or now() - _last >= make_interval(
    secs => public.setting_numeric('points_swipe_min_gap_ms', 1000) / 1000.0));

  select not exists (
    select 1 from public.user_trust t
    where t.user_id = auth.uid()
      and (t.score < public.setting_numeric('trust_review_threshold', 40)
           or t.review_status = 'queued')
  ) into _trusted;

  insert into public.swipes (user_id, post_id, direction)
  values (auth.uid(), _post_id, _direction)
  on conflict (user_id, post_id) do nothing;
  get diagnostics _inserted = row_count;

  if _inserted > 0 then
    begin
      if _dwell_ok and _trusted then
        _balance := public.award_points('swipe', 'swipe', _post_id);
      else
        select points_balance into _balance from public.profiles where id = auth.uid();
      end if;

      if _direction = 'right' then
        select p.like_count, p.likes_rewarded_upto, p.user_id
          into _lc, _upto, _owner
        from public.posts p where p.id = _post_id;
        _buckets := (_lc / 10) - (_upto / 10);
        if _buckets > 0 and _owner is not null and _owner <> auth.uid() then
          perform public._award_to(_owner, _buckets * 3, 'like_milestone', 'post', _post_id);
          update public.posts set likes_rewarded_upto = _lc where id = _post_id;
        end if;
      end if;
    exception when others then
      select points_balance into _balance from public.profiles where id = auth.uid();
    end;
  else
    select points_balance into _balance from public.profiles where id = auth.uid();
  end if;

  return _balance;
end;
$fn$;
revoke all on function public.record_swipe(uuid, text) from public, anon;
grant execute on function public.record_swipe(uuid, text) to authenticated;

delete from public.platform_settings
where key in ('affinity_like_delta', 'affinity_new_tag_delta', 'affinity_skip_delta',
              'affinity_weight_max', 'affinity_weight_min');
