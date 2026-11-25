-- Part 12C: profile showcase — pinned posts, story highlights, link in bio,
-- profile categories.

insert into public.platform_settings (key, value, description, client_visible) values
  ('post_pins_max', to_jsonb(3), 'How many posts can be pinned to a profile.', true),
  ('profile_links_max', to_jsonb(5), 'How many links a profile can show.', true),
  ('profile_links_minors_blocked', to_jsonb(1), 'Under-18 profiles cannot add external links (1 = blocked).', true),
  ('highlight_items_max', to_jsonb(100), 'Maximum stories per highlight.', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Pinned posts (max post_pins_max, owner-only, shown first on the grid).
-- ---------------------------------------------------------------------------
alter table public.posts add column pinned_at timestamptz;
create index posts_pinned on public.posts (user_id, pinned_at desc) where pinned_at is not null;

create or replace function public.set_post_pinned(_post_id uuid, _pinned boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _max integer := public.setting_numeric('post_pins_max', 3)::integer;
begin
  if not exists (select 1 from public.posts p
                 where p.id = _post_id and p.user_id = auth.uid()) then
    raise exception 'not authorised';
  end if;
  if _pinned and (select count(*) from public.posts
                  where user_id = auth.uid() and pinned_at is not null
                    and id <> _post_id) >= _max then
    raise exception 'You can pin up to % posts.', _max;
  end if;
  update public.posts
     set pinned_at = case when _pinned then now() end
   where id = _post_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Story highlights. Items SNAPSHOT the story's media keys and audience at
--    add time, because stories (rows + everything else) expire; the reaper is
--    taught separately to keep highlighted media objects. The original
--    audience is honoured forever: a groups story stays visible only to that
--    group's CURRENT members, and group membership stays secret (nothing in
--    the viewer-facing surface says WHY a highlight item is or isn't there).
-- ---------------------------------------------------------------------------
create table public.story_highlights (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 30),
  cover_url  text,
  position   integer not null default 0,
  created_at timestamptz not null default now()
);
create index story_highlights_user on public.story_highlights (user_id, position);

create table public.story_highlight_items (
  highlight_id  uuid not null references public.story_highlights (id) on delete cascade,
  story_id      uuid,                      -- original story id (row may be reaped)
  media_url     text not null,
  thumbnail_url text,
  media_type    text not null default 'image',
  overlay_text  text,
  audience      text not null default 'default' check (audience in ('default', 'groups')),
  group_ids     uuid[] not null default '{}',
  position      integer not null default 0,
  added_at      timestamptz not null default now(),
  primary key (highlight_id, media_url)
);

alter table public.story_highlights enable row level security;
alter table public.story_highlight_items enable row level security;
revoke all on table public.story_highlights from public, anon, authenticated;
revoke all on table public.story_highlight_items from public, anon, authenticated;
grant select, insert, update, delete on table public.story_highlights to authenticated;
grant select on table public.story_highlight_items to authenticated;

create policy story_highlights_own_write on public.story_highlights
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Anyone can see that a profile HAS highlights (names/covers are public,
-- like Instagram); the ITEMS are audience-filtered in the reader function.
create policy story_highlights_public_read on public.story_highlights
  for select to authenticated using (true);
create policy highlight_items_owner_read on public.story_highlight_items
  for select to authenticated
  using (exists (select 1 from public.story_highlights h
                 where h.id = highlight_id and h.user_id = auth.uid()));

-- Add a LIVE story of your own to a highlight (snapshots audience + media).
create or replace function public.add_story_to_highlight(_highlight_id uuid, _story_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s public.stories;
  _max integer := public.setting_numeric('highlight_items_max', 100)::integer;
begin
  if not exists (select 1 from public.story_highlights h
                 where h.id = _highlight_id and h.user_id = auth.uid()) then
    raise exception 'not authorised';
  end if;
  select * into s from public.stories where id = _story_id and user_id = auth.uid();
  if not found then raise exception 'not authorised'; end if;
  if (select count(*) from public.story_highlight_items where highlight_id = _highlight_id) >= _max then
    raise exception 'This highlight is full.';
  end if;
  insert into public.story_highlight_items
    (highlight_id, story_id, media_url, thumbnail_url, media_type, overlay_text,
     audience, group_ids, position)
  values (_highlight_id, s.id, s.media_url, s.thumbnail_url, s.media_type,
          s.overlay_text, s.audience,
          coalesce((select array_agg(group_id) from public.story_audience_groups
                    where story_id = s.id), '{}'),
          coalesce((select max(position) + 1 from public.story_highlight_items
                    where highlight_id = _highlight_id), 0))
  on conflict do nothing;
  -- Default cover: first item added.
  update public.story_highlights
     set cover_url = coalesce(cover_url, s.thumbnail_url, s.media_url)
   where id = _highlight_id;
end;
$$;

create or replace function public.remove_highlight_item(_highlight_id uuid, _media_url text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from public.story_highlight_items i
  using public.story_highlights h
  where h.id = i.highlight_id and i.highlight_id = _highlight_id
    and i.media_url = _media_url and h.user_id = auth.uid();
  if not found then raise exception 'not authorised'; end if;
end;
$$;

-- Viewer surface: a profile's highlights, and one highlight's items filtered
-- by each item's ORIGINAL audience. 'default' items follow normal story
-- visibility (public profile or accepted follower); 'groups' items only for
-- CURRENT members of any snapshotted group (owner always sees everything).
create or replace function public.get_highlights(_user_id uuid)
returns table (id uuid, name text, cover_url text, "position" integer, item_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select h.id, h.name, h.cover_url, h.position,
         (select count(*) from public.story_highlight_items i where i.highlight_id = h.id)
  from public.story_highlights h
  where h.user_id = _user_id
    and not public.is_blocked_with(h.user_id)
  order by h.position, h.created_at;
$$;

create or replace function public.get_highlight_items(_highlight_id uuid)
returns table (media_url text, thumbnail_url text, media_type text,
               overlay_text text, "position" integer, added_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.media_url, i.thumbnail_url, i.media_type, i.overlay_text, i.position, i.added_at
  from public.story_highlight_items i
  join public.story_highlights h on h.id = i.highlight_id
  where i.highlight_id = _highlight_id
    and not public.is_blocked_with(h.user_id)
    and (
      h.user_id = auth.uid()
      or (i.audience = 'default' and public.can_see_stories(auth.uid(), h.user_id))
      or (i.audience = 'groups' and exists (
            select 1 from public.audience_group_members m
            where m.group_id = any (i.group_ids) and m.member_id = auth.uid()))
    )
  order by i.position, i.added_at;
$$;

-- ---------------------------------------------------------------------------
-- 3. Link in bio (max 5, titles, tap counts, blocklist, minors blocked).
-- ---------------------------------------------------------------------------
create table public.link_domain_blocklist (
  domain     text primary key,            -- lowercase registrable domain
  reason     text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.link_domain_blocklist enable row level security;
revoke all on table public.link_domain_blocklist from public, anon, authenticated;

create table public.profile_links (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  title      text not null check (char_length(btrim(title)) between 1 and 40),
  url        text not null check (url ~* '^https?://'),
  position   integer not null default 0,
  tap_count  integer not null default 0,
  created_at timestamptz not null default now()
);
create index profile_links_user on public.profile_links (user_id, position);
alter table public.profile_links enable row level security;
revoke all on table public.profile_links from public, anon, authenticated;
grant select, update, delete on table public.profile_links to authenticated;
-- Owner manages rows (INSERT goes through the checking function only).
create policy profile_links_owner on public.profile_links
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Everyone may read links (they are the public bio surface).
create policy profile_links_read on public.profile_links
  for select to authenticated using (true);

create or replace function public.add_profile_link(_title text, _url text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _max integer := public.setting_numeric('profile_links_max', 5)::integer;
  _minor_block boolean := public.setting_numeric('profile_links_minors_blocked', 1) >= 1;
  _domain text;
  _id uuid;
begin
  if _minor_block and public.is_minor(auth.uid()) then
    raise exception 'Links are not available on under-18 profiles.';
  end if;
  if (select count(*) from public.profile_links where user_id = auth.uid()) >= _max then
    raise exception 'You can add up to % links.', _max;
  end if;
  _domain := lower(regexp_replace(_url, '^https?://(www\.)?([^/:]+).*$', '\2', 'i'));
  if exists (select 1 from public.link_domain_blocklist b
             where b.active and (_domain = b.domain or _domain like '%.' || b.domain)) then
    raise exception 'That link cannot be added.';
  end if;
  insert into public.profile_links (user_id, title, url, position)
  values (auth.uid(), btrim(_title), _url,
          coalesce((select max(position) + 1 from public.profile_links
                    where user_id = auth.uid()), 0))
  returning id into _id;
  return _id;
end;
$$;

-- Tap counting: totals only, never who tapped.
create or replace function public.record_link_tap(_link_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.profile_links set tap_count = tap_count + 1 where id = _link_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. Profile category ("Food creator", "Pizza restaurant") — public text,
--    creators and businesses only in UI, server just bounds it.
-- ---------------------------------------------------------------------------
alter table public.profiles add column category text
  check (category is null or char_length(btrim(category)) between 2 and 40);
grant update (category) on table public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
revoke all on function public.set_post_pinned(uuid, boolean) from public, anon, authenticated;
revoke all on function public.add_story_to_highlight(uuid, uuid) from public, anon, authenticated;
revoke all on function public.remove_highlight_item(uuid, text) from public, anon, authenticated;
revoke all on function public.get_highlights(uuid) from public, anon, authenticated;
revoke all on function public.get_highlight_items(uuid) from public, anon, authenticated;
revoke all on function public.add_profile_link(text, text) from public, anon, authenticated;
revoke all on function public.record_link_tap(uuid) from public, anon, authenticated;
grant execute on function public.set_post_pinned(uuid, boolean) to authenticated;
grant execute on function public.add_story_to_highlight(uuid, uuid) to authenticated;
grant execute on function public.remove_highlight_item(uuid, text) to authenticated;
grant execute on function public.get_highlights(uuid) to authenticated;
grant execute on function public.get_highlight_items(uuid) to authenticated;
grant execute on function public.add_profile_link(text, text) to authenticated;
grant execute on function public.record_link_tap(uuid) to authenticated;
