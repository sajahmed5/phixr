-- Rollback for 20261124110000_analytics_bot_exclusion.
-- Restores get_post_analytics to the 20260729090000 version (raw counters,
-- hard-coded floor of 5) and removes the analytics_min_sample setting.

set search_path = public, extensions;

create or replace function public.get_post_analytics(_post_id uuid)
returns table (
  reach integer, likes integer, skips integer, comments integer, shares integer,
  like_rate double precision, skip_rate double precision, sample_suppressed boolean
) language plpgsql stable security definer set search_path = '' as $fn$
declare
  min_bucket constant integer := 5;  -- suppress rates below this many swipes
  p public.posts;
  total integer;
begin
  select * into p from public.posts where id = _post_id;
  if not found or p.user_id <> auth.uid() then
    raise exception 'not authorised';  -- own posts only
  end if;
  total := p.like_count + p.skip_count;
  return query select
    p.reach_count, p.like_count, p.skip_count, p.comment_count, p.share_count,
    case when total >= min_bucket then p.like_count::double precision / total else null end,
    case when total >= min_bucket then p.skip_count::double precision / total else null end,
    (total < min_bucket);
end;
$fn$;
revoke all on function public.get_post_analytics(uuid) from public, anon;
grant execute on function public.get_post_analytics(uuid) to authenticated;

delete from public.platform_settings where key = 'analytics_min_sample';
