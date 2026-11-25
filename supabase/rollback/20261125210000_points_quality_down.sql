-- Rollback for 20261125210000_points_quality.
-- Restores the capped award_points (3-arg, 20260808130000 behaviour), the
-- pre-Part-5 points_for_reason / add_comment (Part 4 bodies) and
-- award_message_activity v1; removes ring detection, the history RPC and the
-- Part 5A settings. Ledger rows already written stay (data, not schema).
-- NOTE: roll back 20261125220000_boosts first (create_boost's ledger reasons
-- are unaffected, but keep the reverse order discipline).

set search_path = public, extensions;

select cron.unschedule('comment-ring-scan')
where exists (select 1 from cron.job where jobname = 'comment-ring-scan');
drop function if exists public.detect_comment_rings();
drop table if exists public.comment_ring_flags;
drop function if exists public.get_points_history(timestamptz, integer);

create or replace function public.points_for_reason(_reason text)
returns integer
language sql
stable
security definer
set search_path = ''
as $fn$
  select case _reason
    when 'swipe'            then public.setting_numeric('points_value_swipe', 1)::integer
    when 'comment'          then public.setting_numeric('points_value_comment', 5)::integer
    when 'comment_reply'    then public.setting_numeric('points_value_comment_reply', 5)::integer
    when 'comment_reaction' then public.setting_numeric('points_value_comment_reaction', 2)::integer
    when 'share'            then public.setting_numeric('points_value_share', 3)::integer
    when 'message_new'      then public.setting_numeric('points_value_message_new', 2)::integer
    when 'active_day'       then public.setting_numeric('points_value_active_day', 5)::integer
    else null
  end;
$fn$;

drop function if exists public.award_points(text, text, uuid, numeric);
create function public.award_points(
  _reason   text,
  _ref_type text default null,
  _ref_id   uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _user_id uuid := auth.uid();
  _base integer; _delta integer; _balance bigint;
  _today_reason integer; _today_total bigint;
  _daily_cap constant integer := 1000;
begin
  if _user_id is null then raise exception 'award_points: not authenticated'; end if;
  _base := public.points_for_reason(_reason);
  if _base is null then raise exception 'award_points: reason % is not awardable', _reason; end if;
  _delta := _base;

  select count(*) into _today_reason
  from public.points_ledger
  where user_id = _user_id and reason = _reason and delta > 0
    and created_at >= date_trunc('day', now());

  if    _reason = 'swipe'       and _today_reason >= 200 then _delta := 0;
  elsif _reason = 'share'       and _today_reason >= 5   then _delta := 0;
  elsif _reason = 'message_new' and _today_reason >= 5   then _delta := 0;
  elsif _reason = 'active_day'  and _today_reason >= 1   then _delta := 0;
  end if;

  if _delta > 0 then
    select coalesce(sum(delta), 0) into _today_total
    from public.points_ledger
    where user_id = _user_id and delta > 0 and created_at >= date_trunc('day', now());
    _delta := least(_delta, greatest(_daily_cap - _today_total, 0));
  end if;

  if _delta <> 0 then
    perform public._award_to(_user_id, _delta, _reason, _ref_type, _ref_id);
  end if;

  select points_balance into _balance from public.profiles where id = _user_id;
  return _balance;
end;
$fn$;
revoke all on function public.award_points(text, text, uuid) from public, anon, authenticated;

-- add_comment back to the Part 4 body (groups gate, no quality factor).
create or replace function public.add_comment(_post_id uuid, _body text, _parent_id uuid default null)
returns public.comments
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid    uuid := auth.uid();
  _clean  text := btrim(_body);
  _vis    text;
  _row    public.comments;
begin
  if _uid is null then
    raise exception 'add_comment: not authenticated';
  end if;
  if char_length(_clean) = 0 then
    raise exception 'add_comment: comment is empty';
  end if;
  if char_length(_clean) > 1000 then
    raise exception 'add_comment: comment is too long';
  end if;

  select p.visibility into _vis
  from public.posts p
  where p.id = _post_id
    and p.moderation_status <> 'removed'
    and not public.is_blocked_with(p.user_id)
    and (
      p.user_id = _uid
      or (p.visibility = 'public' and p.moderation_status = 'approved')
      or (p.visibility = 'private' and public.is_accepted_follower_of(p.user_id))
      or (p.visibility = 'groups' and public.is_accepted_follower_of(p.user_id)
          and public.viewer_in_post_groups(p.id))
    );
  if _vis is null then
    raise exception 'add_comment: post not available';
  end if;

  if _parent_id is not null then
    if not exists (
      select 1 from public.comments c
      where c.id = _parent_id and c.post_id = _post_id and c.parent_comment_id is null
    ) then
      raise exception 'add_comment: invalid parent comment';
    end if;
  end if;

  insert into public.comments (post_id, user_id, parent_comment_id, body)
  values (_post_id, _uid, _parent_id, _clean)
  returning * into _row;

  if char_length(_clean) >= 2 and _vis <> 'groups' then
    perform public.award_points(
      case when _parent_id is null then 'comment' else 'comment_reply' end,
      'comment',
      _row.id
    );
  end if;

  return _row;
end;
$fn$;

create or replace function public.award_message_activity(_conversation_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return public.award_points('message_new', 'conversation', _conversation_id);
end;
$fn$;

delete from public.platform_settings where key in (
  'points_daily_ceiling', 'points_value_message_reply',
  'points_reply_short_len', 'points_reply_long_len',
  'points_reply_short_factor', 'points_reply_long_factor',
  'points_repeat_decay', 'points_duplicate_window_days',
  'ring_window_days', 'ring_mutual_threshold');
