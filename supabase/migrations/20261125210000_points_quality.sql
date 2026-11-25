-- Part 5A: points for engagement — quality over caps.
--
-- The brief: no daily caps; instead, quality gates decide what earns.
-- DECIDED WITH SAJ (2026-11-25): the per-reason daily caps from
-- 20260808130000 go; ONE settings-driven global daily ceiling stays as an
-- abuse safety valve (admins can raise it to effectively disable it).
--
-- What earns now:
--   * genuine deck swipes (dwell + trust gates, Part 1 — unchanged)
--   * comments and replies, scaled by QUALITY:
--       - a repeat of your own recent comment text earns NOTHING
--       - short ("thanks!", emoji) earns a fraction; long thoughtful earns more
--       - replying to the same person again and again decays per reply today
--   * replying to a DM from one of your (accepted) followers — NEW
--     'message_reply', with the same per-conversation daily decay
--   * posting content that performs well — the existing like_milestone
--     creator reward (every 10 bot-cleaned likes), unchanged
-- Bot-flagged accounts already earn nothing (Part 1C trust gate).
--
-- Comment rings (small groups farming each other) are DETECTED and flagged
-- to fame-admin (comment_ring_flags + daily cron) — no auto-penalty; a human
-- decides, as the brief asks.
--
-- award_points gains a _factor parameter (quality multiplier). The old 3-arg
-- signature is dropped; every existing caller resolves to the new one via the
-- default. Group posts still award nothing (Part 4 gates preserved verbatim).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Settings.
-- ---------------------------------------------------------------------------
insert into public.platform_settings (key, value, description, client_visible) values
  ('points_daily_ceiling',          '2000'::jsonb, 'Global daily points-earn ceiling per user (abuse safety valve; per-reason caps were removed in Part 5). Raise to effectively disable.', false),
  ('points_value_message_reply',    '2'::jsonb,    'Points for replying to a DM from an accepted follower (Part 5A).', false),
  ('points_reply_short_len',        '20'::jsonb,   'Comments/replies at or under this many characters earn points_reply_short_factor of the base value.', false),
  ('points_reply_long_len',         '120'::jsonb,  'Comments/replies at or over this many characters earn points_reply_long_factor of the base value.', false),
  ('points_reply_short_factor',     '0.25'::jsonb, 'Multiplier for short comments/replies ("thanks!", emoji-only).', false),
  ('points_reply_long_factor',      '2'::jsonb,    'Multiplier for long, thoughtful comments/replies.', false),
  ('points_repeat_decay',           '0.5'::jsonb,  'Each later comment today on the SAME author''s posts (or reply in the same conversation) multiplies the award by this.', false),
  ('points_duplicate_window_days',  '7'::jsonb,    'A comment matching your own comment text within this window earns nothing.', false),
  ('ring_window_days',              '7'::jsonb,    'Window the comment-ring scan looks across.', false),
  ('ring_mutual_threshold',         '10'::jsonb,   'Both directions of a pair must reach this many comments in the window to be flagged as a possible ring.', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. points_for_reason learns message_reply.
-- ---------------------------------------------------------------------------
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
    when 'message_reply'    then public.setting_numeric('points_value_message_reply', 2)::integer
    when 'active_day'       then public.setting_numeric('points_value_active_day', 5)::integer
    else null
  end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. award_points v3: caps out, quality factor in, ceiling from settings.
--    active_day stays once-per-day — that is the award's definition, not a cap.
-- ---------------------------------------------------------------------------
drop function if exists public.award_points(text, text, uuid);
create function public.award_points(
  _reason   text,
  _ref_type text default null,
  _ref_id   uuid default null,
  _factor   numeric default 1
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _user_id uuid := auth.uid();
  _base    integer;
  _delta   integer;
  _balance bigint;
  _today_total bigint;
  _ceiling integer := public.setting_numeric('points_daily_ceiling', 2000)::integer;
begin
  if _user_id is null then
    raise exception 'award_points: not authenticated';
  end if;
  _base := public.points_for_reason(_reason);
  if _base is null then
    raise exception 'award_points: reason % is not awardable', _reason;
  end if;
  _delta := floor(_base * greatest(coalesce(_factor, 1), 0))::integer;

  -- active_day is by definition once per day.
  if _reason = 'active_day' and exists (
    select 1 from public.points_ledger l
    where l.user_id = _user_id and l.reason = 'active_day' and l.delta > 0
      and l.created_at >= date_trunc('day', now())
  ) then
    _delta := 0;
  end if;

  -- The one remaining ceiling: global, settings-driven, abuse-only.
  if _delta > 0 then
    select coalesce(sum(l.delta), 0) into _today_total
    from public.points_ledger l
    where l.user_id = _user_id and l.delta > 0
      and l.created_at >= date_trunc('day', now());
    _delta := least(_delta, greatest(_ceiling - _today_total, 0)::integer);
  end if;

  if _delta <> 0 then
    perform public._award_to(_user_id, _delta, _reason, _ref_type, _ref_id);
  end if;

  select points_balance into _balance from public.profiles where id = _user_id;
  return _balance;
end;
$fn$;
revoke all on function public.award_points(text, text, uuid, numeric)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. add_comment v5: quality factor (duplicates 0, short fraction, long
--    bonus, per-author repeat decay). Part 4's group gates kept verbatim.
-- ---------------------------------------------------------------------------
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
  _owner  uuid;
  _row    public.comments;
  _short_len integer := public.setting_numeric('points_reply_short_len', 20)::integer;
  _long_len  integer := public.setting_numeric('points_reply_long_len', 120)::integer;
  _short_f   numeric := public.setting_numeric('points_reply_short_factor', 0.25);
  _long_f    numeric := public.setting_numeric('points_reply_long_factor', 2);
  _decay     numeric := public.setting_numeric('points_repeat_decay', 0.5);
  _dup_days  integer := public.setting_numeric('points_duplicate_window_days', 7)::integer;
  _factor    numeric := 1;
  _repeats   integer;
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

  -- The post must be visible to this user (mirrors the posts SELECT policy).
  select p.visibility, p.user_id into _vis, _owner
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

  -- Quality factor (Part 5A). Never blocks the comment itself.
  if char_length(_clean) < 2 or _vis = 'groups' then
    _factor := 0;  -- too short to score / group posts never feed points (4A)
  else
    -- Copy-paste of your own recent comment text → nothing.
    if exists (
      select 1 from public.comments c
      where c.user_id = _uid and c.id <> _row.id
        and c.created_at > now() - make_interval(days => _dup_days)
        and lower(btrim(c.body)) = lower(_clean)
    ) then
      _factor := 0;
    else
      if char_length(_clean) <= _short_len then
        _factor := _short_f;
      elsif char_length(_clean) >= _long_len then
        _factor := _long_f;
      end if;
      -- Same-author repeat decay: each earlier comment TODAY on this
      -- author's posts halves (by default) this one's award.
      select count(*) into _repeats
      from public.comments c
      join public.posts p2 on p2.id = c.post_id
      where c.user_id = _uid and c.id <> _row.id
        and p2.user_id = _owner
        and c.created_at >= date_trunc('day', now());
      _factor := _factor * power(_decay, least(_repeats, 20));
    end if;
  end if;

  if _factor > 0 then
    perform public.award_points(
      case when _parent_id is null then 'comment' else 'comment_reply' end,
      'comment',
      _row.id,
      _factor
    );
  end if;

  return _row;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. DM awards v2: starting a conversation earns message_new (as before);
--    REPLYING to a DM from an accepted follower earns message_reply with a
--    per-conversation daily decay. Double-texting earns nothing.
-- ---------------------------------------------------------------------------
create or replace function public.award_message_activity(_conversation_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid uuid := auth.uid();
  _my_prev timestamptz;
  _their_last timestamptz;
  _other uuid;
  _decay numeric := public.setting_numeric('points_repeat_decay', 0.5);
  _today integer;
  _balance bigint;
begin
  if _uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.conversation_members m
                 where m.conversation_id = _conversation_id and m.user_id = _uid) then
    raise exception 'not a member';
  end if;

  -- My previous message BEFORE the one just sent; the other side's latest.
  select m.created_at into _my_prev
  from public.messages m
  where m.conversation_id = _conversation_id and m.sender_id = _uid
  order by m.created_at desc offset 1 limit 1;
  select m.created_at, m.sender_id into _their_last, _other
  from public.messages m
  where m.conversation_id = _conversation_id and m.sender_id <> _uid
  order by m.created_at desc limit 1;

  if _their_last is null and _my_prev is null then
    -- First message of the conversation: starting counts (as before).
    return public.award_points('message_new', 'conversation', _conversation_id);
  end if;

  if _their_last is not null and (_my_prev is null or _their_last > _my_prev) then
    -- A genuine reply to their DM — earns when they accepted-follow me.
    if exists (
      select 1 from public.follows f
      where f.follower_id = _other and f.followee_id = _uid and f.status = 'accepted'
    ) then
      select count(*) into _today
      from public.points_ledger l
      where l.user_id = _uid and l.reason = 'message_reply' and l.delta > 0
        and l.ref_id = _conversation_id
        and l.created_at >= date_trunc('day', now());
      return public.award_points('message_reply', 'conversation', _conversation_id,
                                 power(_decay, least(_today, 20)));
    end if;
  end if;

  select points_balance into _balance from public.profiles where id = _uid;
  return _balance;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Comment-ring detection: pairs farming each other, flagged to fame-admin.
--    Detection only — a human decides (brief 5A).
-- ---------------------------------------------------------------------------
create table public.comment_ring_flags (
  id          uuid primary key default gen_random_uuid(),
  user_a      uuid not null references public.profiles (id) on delete cascade,
  user_b      uuid not null references public.profiles (id) on delete cascade,
  a_to_b      integer not null,   -- comments by A on B's posts in the window
  b_to_a      integer not null,
  window_days integer not null,
  status      text not null default 'open' check (status in ('open', 'dismissed', 'actioned')),
  flagged_at  timestamptz not null default now(),
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  unique (user_a, user_b)
);
alter table public.comment_ring_flags enable row level security;
revoke all on table public.comment_ring_flags from public, anon, authenticated;

create or replace function public.detect_comment_rings()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _days integer := public.setting_numeric('ring_window_days', 7)::integer;
  _min  integer := public.setting_numeric('ring_mutual_threshold', 10)::integer;
begin
  with pair_counts as (
    select c.user_id as commenter, p.user_id as author, count(*) as n
    from public.comments c
    join public.posts p on p.id = c.post_id
    where c.created_at > now() - make_interval(days => _days)
      and c.user_id <> p.user_id
      and c.deleted_at is null
    group by c.user_id, p.user_id
    having count(*) >= _min
  ),
  mutual as (
    -- Ordered pair once (a < b) with both directions over threshold.
    select least(x.commenter, x.author) as user_a,
           greatest(x.commenter, x.author) as user_b,
           max(case when x.commenter < x.author then x.n end) as a_to_b,
           max(case when x.commenter > x.author then x.n end) as b_to_a
    from pair_counts x
    group by least(x.commenter, x.author), greatest(x.commenter, x.author)
    having count(*) = 2   -- both directions present
  )
  insert into public.comment_ring_flags as f
    (user_a, user_b, a_to_b, b_to_a, window_days)
  select m.user_a, m.user_b, m.a_to_b, m.b_to_a, _days
  from mutual m
  on conflict (user_a, user_b) do update
    set a_to_b = excluded.a_to_b,
        b_to_a = excluded.b_to_a,
        window_days = excluded.window_days,
        flagged_at = now(),
        -- A dismissed pair that trips again reopens; actioned stays actioned.
        status = case when f.status = 'dismissed' then 'open' else f.status end;
end;
$fn$;
revoke all on function public.detect_comment_rings() from public, anon, authenticated;

select cron.schedule('comment-ring-scan', '15 4 * * *',
                     $$select public.detect_comment_rings();$$)
where not exists (select 1 from cron.job where jobname = 'comment-ring-scan');

-- ---------------------------------------------------------------------------
-- 7. Points history (brief: show creators clearly how they earned).
--    Owner-only; never references other users or individual swipes beyond
--    the caller's own actions.
-- ---------------------------------------------------------------------------
create or replace function public.get_points_history(
  _before timestamptz default null,
  _limit integer default 50
)
returns table (reason text, delta integer, ref_type text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $fn$
  select l.reason, l.delta, l.ref_type, l.created_at
  from public.points_ledger l
  where l.user_id = auth.uid()
    and (_before is null or l.created_at < _before)
  order by l.created_at desc
  limit greatest(_limit, 0);
$fn$;
revoke all on function public.get_points_history(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.get_points_history(timestamptz, integer) to authenticated;
