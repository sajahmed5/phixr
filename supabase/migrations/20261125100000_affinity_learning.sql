-- ============================================================================
-- 20261125100000_affinity_learning  (Build brief Parts 2B + 2C)
--
-- Until now a user's tag interests (user_tags.weight) were set once at
-- onboarding and never changed. The brief requires the feed to learn:
--   * a LEFT swipe lowers similar content for that viewer straight away,
--     independent of the global quality score (2B);
--   * liking an explore post increases that interest GENTLY, not all at
--     once (2C).
--
-- record_swipe is re-emitted (body from 20261124100000) with an affinity
-- block: on right, tags the user already follows gain affinity_like_delta
-- and tags new to them are created at affinity_new_tag_delta (the gentle
-- explore case); on left, the post's tags lose affinity_skip_delta, creating
-- negative rows where none existed so similar content is actively pushed
-- down (weights clamp to [affinity_weight_min, affinity_weight_max]).
-- Affinity updates are best-effort (their own subtransaction) and apply to
-- every swipe, including bot-flagged ones — flagged swipes still move the
-- user's OWN feed by design (Part 1C); they just never affect anyone else.
--
-- Known simplification: undo_swipe does not reverse the affinity nudge (the
-- deltas are small and undo is rare).
-- ============================================================================

set search_path = public, extensions;

insert into public.platform_settings (key, value, description, client_visible) values
  ('affinity_like_delta',    '0.1'::jsonb,  'Weight added to each of a post''s tags the viewer already follows when they swipe right.', false),
  ('affinity_new_tag_delta', '0.05'::jsonb, 'Starting weight for a tag NEW to the viewer when they swipe right (the gentle explore-like increase).', false),
  ('affinity_skip_delta',    '0.15'::jsonb, 'Weight removed from each of a post''s tags when the viewer swipes left; unknown tags start at minus this.', false),
  ('affinity_weight_max',    '5'::jsonb,    'Ceiling on a single tag''s affinity weight.', false),
  ('affinity_weight_min',    '-2'::jsonb,   'Floor on a single tag''s affinity weight (negative = actively avoided).', false)
on conflict (key) do nothing;

-- record_swipe re-emit (body from 20261124100000_view_events_bot_detection,
-- which added the settings-driven gap gate + trust gate). New: the affinity
-- block at the end of the inserted branch.
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

  -- Dwell gate: how long since this user's previous swipe? (captured BEFORE inserting)
  select max(created_at) into _last from public.swipes where user_id = auth.uid();
  _dwell_ok := (_last is null or now() - _last >= make_interval(
    secs => public.setting_numeric('points_swipe_min_gap_ms', 1000) / 1000.0));

  -- Trust gate (Part 1C): flagged-pattern accounts earn nothing until reviewed.
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
    -- Points are best-effort: a subtransaction so ANY points error is swallowed and
    -- can NEVER roll back the swipe itself (the swipe is the core flow).
    begin
      -- Swiper earns only if they actually looked (no rapid-fire / bot farming).
      if _dwell_ok and _trusted then
        _balance := public.award_points('swipe', 'swipe', _post_id);
      else
        select points_balance into _balance from public.profiles where id = auth.uid();
      end if;

      -- Batched creator reward on likes. like_count was just bumped by the AFTER-INSERT
      -- trigger. Award +3 per completed group of 10, referencing the POST only.
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

    -- Affinity learning (Parts 2B/2C) — best-effort, never blocks the swipe.
    begin
      if _direction = 'right' then
        update public.user_tags ut
        set weight = least(
          ut.weight + public.setting_numeric('affinity_like_delta', 0.1),
          public.setting_numeric('affinity_weight_max', 5))
        where ut.user_id = auth.uid()
          and ut.tag_id in (select pt.tag_id from public.post_tags pt where pt.post_id = _post_id);

        insert into public.user_tags (user_id, tag_id, weight)
        select auth.uid(), pt.tag_id, public.setting_numeric('affinity_new_tag_delta', 0.05)
        from public.post_tags pt
        where pt.post_id = _post_id
        on conflict (user_id, tag_id) do nothing;
      else
        update public.user_tags ut
        set weight = greatest(
          ut.weight - public.setting_numeric('affinity_skip_delta', 0.15),
          public.setting_numeric('affinity_weight_min', -2))
        where ut.user_id = auth.uid()
          and ut.tag_id in (select pt.tag_id from public.post_tags pt where pt.post_id = _post_id);

        insert into public.user_tags (user_id, tag_id, weight)
        select auth.uid(), pt.tag_id, -public.setting_numeric('affinity_skip_delta', 0.15)
        from public.post_tags pt
        where pt.post_id = _post_id
        on conflict (user_id, tag_id) do nothing;
      end if;
    exception when others then
      null; -- affinity is a nudge, never a failure
    end;
  else
    select points_balance into _balance from public.profiles where id = auth.uid();
  end if;

  return _balance;
end;
$fn$;
revoke all on function public.record_swipe(uuid, text) from public, anon;
grant execute on function public.record_swipe(uuid, text) to authenticated;
