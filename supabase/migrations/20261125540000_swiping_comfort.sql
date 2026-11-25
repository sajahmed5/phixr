-- Part 14A: swiping comfort — multi-step undo, "not interested" topics,
-- "show me more like this", and a plain-words interests read for the
-- settings screen (the feed stops being a black box).

insert into public.platform_settings (key, value, description, client_visible) values
  ('swipe_undo_depth', to_jsonb(3), 'How many recent swipes a user can undo.', true),
  ('affinity_show_more_delta', to_jsonb(0.3), 'Weight bump when a user asks for more like this.', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Not-interested topics: excluded from the deck until muted_until (null =
-- forever). Plain own-rows RLS; the deck filter lands in get_deck v10-c.
-- ---------------------------------------------------------------------------
create table public.muted_topics (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  tag_id      uuid not null references public.tags (id) on delete cascade,
  muted_until timestamptz,           -- null = forever
  created_at  timestamptz not null default now(),
  primary key (user_id, tag_id)
);
alter table public.muted_topics enable row level security;
revoke all on table public.muted_topics from public, anon, authenticated;
grant select, insert, update, delete on table public.muted_topics to authenticated;
create policy muted_topics_own on public.muted_topics
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace function public.mute_topic(_tag_id uuid, _days integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if _days is not null and _days not in (30, 90) then
    raise exception 'Mute for 30 days, 90 days, or forever.';
  end if;
  insert into public.muted_topics (user_id, tag_id, muted_until)
  values (auth.uid(), _tag_id,
          case when _days is null then null else now() + make_interval(days => _days) end)
  on conflict (user_id, tag_id)
  do update set muted_until = excluded.muted_until, created_at = now();
end;
$$;

create or replace function public.unmute_topic(_tag_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from public.muted_topics where user_id = auth.uid() and tag_id = _tag_id;
$$;

-- "Show me more like this": a gentle, capped bump of the post's topics.
create or replace function public.show_more_like_this(_post_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _delta numeric := public.setting_numeric('affinity_show_more_delta', 0.3);
  _max   numeric := public.setting_numeric('affinity_weight_max', 5);
begin
  update public.user_tags ut
  set weight = least(ut.weight + _delta, _max)
  where ut.user_id = auth.uid()
    and ut.tag_id in (select pt.tag_id from public.post_tags pt where pt.post_id = _post_id);

  insert into public.user_tags (user_id, tag_id, weight)
  select auth.uid(), pt.tag_id, _delta
  from public.post_tags pt
  where pt.post_id = _post_id
  on conflict (user_id, tag_id) do nothing;

  -- Asking for more also lifts any mute on those topics.
  delete from public.muted_topics
  where user_id = auth.uid()
    and tag_id in (select pt.tag_id from public.post_tags pt where pt.post_id = _post_id);
end;
$$;

-- The interests screen: top learned interests in plain words, with mute state.
create or replace function public.get_my_interests(_limit integer default 20)
returns table (tag_id uuid, name text, weight numeric, level text, muted boolean, muted_until timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.name, ut.weight::numeric,
         case
           when ut.weight >= 2 then 'A big interest'
           when ut.weight >= 0.5 then 'An interest'
           when ut.weight > 0 then 'A slight interest'
           else 'Not your thing'
         end as level,
         (mt.user_id is not null and (mt.muted_until is null or mt.muted_until > now())) as muted,
         mt.muted_until
  from public.user_tags ut
  join public.tags t on t.id = ut.tag_id
  left join public.muted_topics mt on mt.user_id = ut.user_id and mt.tag_id = ut.tag_id
  where ut.user_id = auth.uid()
  order by ut.weight desc
  limit greatest(least(coalesce(_limit, 20), 50), 1);
$$;

-- "That's not me": drop a learned interest entirely.
create or replace function public.remove_interest(_tag_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from public.user_tags where user_id = auth.uid() and tag_id = _tag_id;
$$;

-- ---------------------------------------------------------------------------
-- undo_swipe v2: v1 removed the swipe row (the counts trigger reverses
-- like/skip/reach on DELETE) and clawed back the points. v2 also reverses
-- the interest-weight change, so an undone swipe is REPLACED, not counted
-- twice, everywhere analytics and ranking look.
-- ---------------------------------------------------------------------------
create or replace function public.undo_swipe(_post_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  _deleted   integer;
  _original  integer;
  _balance   bigint;
  _direction text;
begin
  select direction into _direction
  from public.swipes where user_id = auth.uid() and post_id = _post_id;

  delete from public.swipes where user_id = auth.uid() and post_id = _post_id;
  get diagnostics _deleted = row_count;

  if _deleted > 0 then
    -- Find what the original swipe awarded and post a compensating negative row.
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

    -- Reverse the affinity move record_swipe made for this direction.
    begin
      if _direction = 'right' then
        update public.user_tags ut
        set weight = greatest(
          ut.weight - public.setting_numeric('affinity_like_delta', 0.1),
          public.setting_numeric('affinity_weight_min', -2))
        where ut.user_id = auth.uid()
          and ut.tag_id in (select pt.tag_id from public.post_tags pt where pt.post_id = _post_id);
      elsif _direction = 'left' then
        update public.user_tags ut
        set weight = least(
          ut.weight + public.setting_numeric('affinity_skip_delta', 0.15),
          public.setting_numeric('affinity_weight_max', 5))
        where ut.user_id = auth.uid()
          and ut.tag_id in (select pt.tag_id from public.post_tags pt where pt.post_id = _post_id);
      end if;
    exception when others then
      null;  -- affinity reversal is best-effort, never blocks the undo
    end;
  end if;

  select points_balance into _balance from public.profiles where id = auth.uid();
  return _balance;
end;
$$;

revoke all on function public.mute_topic(uuid, integer) from public, anon, authenticated;
revoke all on function public.unmute_topic(uuid) from public, anon, authenticated;
revoke all on function public.show_more_like_this(uuid) from public, anon, authenticated;
revoke all on function public.get_my_interests(integer) from public, anon, authenticated;
revoke all on function public.remove_interest(uuid) from public, anon, authenticated;
grant execute on function public.mute_topic(uuid, integer) to authenticated;
grant execute on function public.unmute_topic(uuid) to authenticated;
grant execute on function public.show_more_like_this(uuid) to authenticated;
grant execute on function public.get_my_interests(integer) to authenticated;
grant execute on function public.remove_interest(uuid) to authenticated;
