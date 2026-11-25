-- Part 4B: likes privacy — likers list, delayed+grouped like notifications,
-- verified highlight, and the quiet-likes setting.
--
-- CONFLICT RESOLVED WITH SAJ (2026-11-25): the original push design
-- (20260730090000) banned like notifications outright because a real-time
-- "X liked your post" reveals when X was swiping. The brief (4B) wants
-- Instagram-style likers + notifications; Saj chose the middle path — likes
-- queue up and a pg_cron job flushes them every few minutes as ONE grouped
-- notification per post ("Sam and 24 others liked your post"), so no
-- notification is ever tied to the moment of an individual swipe.
--
-- Still absolute: left swipes NEVER appear anywhere as an individual action;
-- nobody can browse another user's like history (get_my_swipes stays
-- owner-only; nothing else exposes it).
--
-- "Hide my likes" (profiles.hide_likes): quiet likers are left out of the
-- likers list and are never the NAMED actor in a notification; they still
-- count inside "and N others" and in all totals.
--
-- profiles.verified: display flag for the "The Rock liked your post"
-- highlight; set by admins via service role only (no client grant).

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Profile flags.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column hide_likes boolean not null default false,
  add column verified   boolean not null default false;
grant update (hide_likes) on public.profiles to authenticated;
-- verified: service_role only, on purpose.

-- ---------------------------------------------------------------------------
-- 2. Settings.
-- ---------------------------------------------------------------------------
insert into public.platform_settings (key, value, description, client_visible) values
  ('like_notification_min_age_minutes', '0'::jsonb,
   'Extra minimum age (minutes) a queued like must reach before the 5-minute flush job may include it. 0 = flush everything each run.', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Notification type.
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'new_follower','follow_request','follow_accepted',
    'comment','reply','comment_reaction','reach_milestone','moderation','message','mention','like'));

-- ---------------------------------------------------------------------------
-- 4. The like queue. Written by triggers on swipes (right only) and feed
--    hearts; drained by the flush job. No app access — its existence must
--    not create a readable record of who liked what beyond the likers list.
-- ---------------------------------------------------------------------------
create table public.like_notification_queue (
  post_id   uuid not null references public.posts (id) on delete cascade,
  actor_id  uuid not null references public.profiles (id) on delete cascade,
  source    text not null check (source in ('deck', 'feed')),
  created_at timestamptz not null default now(),
  primary key (post_id, actor_id, source)
);
alter table public.like_notification_queue enable row level security;
revoke all on table public.like_notification_queue from public, anon, authenticated;

create or replace function public.tg_like_queue_swipe()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    if new.direction = 'right' then
      insert into public.like_notification_queue (post_id, actor_id, source)
      select new.post_id, new.user_id, 'deck'
      from public.posts p
      where p.id = new.post_id and p.user_id <> new.user_id
      on conflict do nothing;
    end if;
    return new;
  end if;
  -- undo / delete: a like that was never announced should never be
  delete from public.like_notification_queue q
  where q.post_id = old.post_id and q.actor_id = old.user_id and q.source = 'deck';
  return old;
end;
$fn$;
revoke all on function public.tg_like_queue_swipe() from public, anon, authenticated;
create trigger like_queue_swipe
  after insert or delete on public.swipes
  for each row execute function public.tg_like_queue_swipe();

create or replace function public.tg_like_queue_heart()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    insert into public.like_notification_queue (post_id, actor_id, source)
    select new.post_id, new.user_id, 'feed'
    from public.posts p
    where p.id = new.post_id and p.user_id <> new.user_id
    on conflict do nothing;
    return new;
  end if;
  delete from public.like_notification_queue q
  where q.post_id = old.post_id and q.actor_id = old.user_id and q.source = 'feed';
  return old;
end;
$fn$;
revoke all on function public.tg_like_queue_heart() from public, anon, authenticated;
create trigger like_queue_heart
  after insert or delete on public.post_likes
  for each row execute function public.tg_like_queue_heart();

-- ---------------------------------------------------------------------------
-- 5. The flush job: one grouped notification per post per run. The named
--    actor is the newest non-quiet liker, preferring a VERIFIED account (the
--    brief's "The Rock liked your post" highlight travels in payload).
-- ---------------------------------------------------------------------------
create or replace function public.flush_like_notifications()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _min_age numeric := public.setting_numeric('like_notification_min_age_minutes', 0);
  r record;
  _named record;
  _existing uuid;
begin
  for r in
    select q.post_id, p.user_id as owner, count(distinct q.actor_id)::integer as n
    from public.like_notification_queue q
    join public.posts p on p.id = q.post_id
    where q.created_at <= now() - make_interval(mins => _min_age::integer)
    group by q.post_id, p.user_id
  loop
    -- newest non-quiet, non-blocked actor; verified wins
    select pr.id, pr.handle, pr.display_name, pr.verified into _named
    from public.like_notification_queue q
    join public.profiles pr on pr.id = q.actor_id
    where q.post_id = r.post_id
      and pr.hide_likes = false
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = r.owner and b.blocked_id = pr.id)
           or (b.blocker_id = pr.id and b.blocked_id = r.owner)
      )
    order by pr.verified desc, q.created_at desc
    limit 1;

    select n2.id into _existing
    from public.notifications n2
    where n2.user_id = r.owner and n2.type = 'like'
      and n2.post_id = r.post_id and n2.read_at is null
    limit 1;

    if _existing is not null then
      update public.notifications
         set count = count + r.n,
             actor_id = coalesce(_named.id, actor_id),
             created_at = now(),
             payload = case when _named.id is not null
               then jsonb_build_object('actor_handle', _named.handle,
                                       'actor_name', _named.display_name,
                                       'verified', _named.verified)
               else payload end
       where id = _existing;
    else
      insert into public.notifications (user_id, type, actor_id, post_id, count, payload)
      values (r.owner, 'like', _named.id, r.post_id, r.n,
              case when _named.id is not null
                then jsonb_build_object('actor_handle', _named.handle,
                                        'actor_name', _named.display_name,
                                        'verified', _named.verified)
                else '{}'::jsonb end);
    end if;

    delete from public.like_notification_queue q
    where q.post_id = r.post_id
      and q.created_at <= now() - make_interval(mins => _min_age::integer);
  end loop;
end;
$fn$;
revoke all on function public.flush_like_notifications() from public, anon, authenticated;

select cron.schedule('like-notifications', '*/5 * * * *',
                     $$select public.flush_like_notifications();$$)
where not exists (select 1 from cron.job where jobname = 'like-notifications');

-- ---------------------------------------------------------------------------
-- 6. The likers list (owner-only; deck likes + feed hearts, deduped, quiet
--    likers and block pairs excluded). Left swipes have no counterpart here
--    and never will.
-- ---------------------------------------------------------------------------
create or replace function public.get_post_likers(
  _post_id uuid,
  _before timestamptz default null,
  _limit integer default 30
)
returns table (
  user_id uuid, handle text, display_name text, avatar_url text,
  verified boolean, liked_at timestamptz, source text
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if not exists (select 1 from public.posts p
                 where p.id = _post_id and p.user_id = auth.uid()) then
    raise exception 'not authorised';  -- your own posts only
  end if;

  return query
  select pr.id, pr.handle, pr.display_name, pr.avatar_url, pr.verified,
         l.liked_at, l.source
  from (
    select distinct on (x.user_id) x.user_id, x.liked_at, x.source
    from (
      select sw.user_id, sw.created_at as liked_at, 'deck'::text as source
      from public.swipes sw
      where sw.post_id = _post_id and sw.direction = 'right'
      union all
      select pl.user_id, pl.created_at, 'feed'::text
      from public.post_likes pl
      where pl.post_id = _post_id
    ) x
    order by x.user_id, x.liked_at desc
  ) l
  join public.profiles pr on pr.id = l.user_id
  where pr.hide_likes = false
    and not public.is_blocked_with(pr.id)
    and (_before is null or l.liked_at < _before)
  order by l.liked_at desc
  limit greatest(_limit, 0);
end;
$fn$;
revoke all on function public.get_post_likers(uuid, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.get_post_likers(uuid, timestamptz, integer) to authenticated;
