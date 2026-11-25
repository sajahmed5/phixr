-- Part 14E: saved collections grow up (rename, reorder, chosen cover) and
-- videos get creator-editable captions. External sharing itself is client +
-- link-domain work; the server gate already exists (get_public_post serves
-- public posts only, so group/follower-only links lead nowhere).

alter table public.collections
  add column position integer not null default 0,
  add column cover_post_id uuid references public.posts (id) on delete set null;

-- Backfill stable positions by current display order (newest first).
with ranked as (
  select id, row_number() over (partition by user_id order by created_at desc) - 1 as rn
  from public.collections
)
update public.collections c set position = r.rn from ranked r where r.id = c.id;

create or replace function public.rename_collection(_id uuid, _name text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if char_length(btrim(coalesce(_name, ''))) not between 1 and 40 then
    raise exception 'Collection names are 1–40 characters.';
  end if;
  update public.collections set name = btrim(_name)
  where id = _id and user_id = auth.uid();
  if not found then raise exception 'not authorised'; end if;
end;
$$;

-- Reorder by passing every collection id in the wanted order.
create or replace function public.reorder_collections(_ids uuid[])
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.collections c
  set position = x.ord - 1
  from unnest(_ids) with ordinality as x(id, ord)
  where c.id = x.id and c.user_id = auth.uid();
$$;

-- Choose a cover (must be a post saved IN that collection); null = automatic.
create or replace function public.set_collection_cover(_id uuid, _post_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if _post_id is not null and not exists (
    select 1 from public.bookmarks b
    where b.user_id = auth.uid() and b.collection_id = _id and b.post_id = _post_id) then
    raise exception 'Pick a post saved in this collection.';
  end if;
  update public.collections set cover_post_id = _post_id
  where id = _id and user_id = auth.uid();
  if not found then raise exception 'not authorised'; end if;
end;
$$;

-- get_collections v2: honour position + the chosen cover.
create or replace function public.get_collections()
returns table (id uuid, name text, item_count bigint, cover_url text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.name,
    (select count(*) from public.bookmarks b where b.collection_id = c.id and b.user_id = auth.uid()),
    coalesce(
      (select p.thumbnail_url from public.posts p where p.id = c.cover_post_id),
      (select p.thumbnail_url from public.bookmarks b
         join public.posts p on p.id = b.post_id
         where b.collection_id = c.id and b.user_id = auth.uid()
         order by b.created_at desc limit 1)),
    c.created_at
  from public.collections c
  where c.user_id = auth.uid()
  order by c.position asc, c.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- Video captions (14E accessibility): creator-editable text, moderated like
-- any other text. Reads ride the existing posts policies; auto-generation
-- plugs in later as a service writing through the same function.
-- ---------------------------------------------------------------------------
alter table public.posts
  add column video_captions text check (video_captions is null or char_length(video_captions) <= 5000);

create or replace function public.set_video_captions(_post_id uuid, _captions text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _clean text := nullif(btrim(coalesce(_captions, '')), '');
begin
  if not exists (select 1 from public.posts p
                 where p.id = _post_id and p.user_id = auth.uid() and p.media_type = 'video') then
    raise exception 'not authorised';
  end if;
  if _clean is not null and public.moderate_text(_clean) = 'removed' then
    raise exception 'Those captions can''t be saved. Please reword them.';
  end if;
  update public.posts set video_captions = _clean where id = _post_id;
end;
$$;

-- Lazy caption read for the deck/post player (any post the viewer can see
-- through the deck is public or an approved ad; own posts always).
create or replace function public.get_video_captions(_post_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.video_captions from public.posts p
  where p.id = _post_id
    and (p.user_id = auth.uid()
         or (p.moderation_status = 'approved' and p.visibility in ('public', 'ad')));
$$;

-- Hygiene: legacy broad grants on posts nothing uses (TRUNCATE would bypass
-- RLS if any SQL path ever existed for the role).
revoke truncate, trigger, references on table public.posts from public, anon, authenticated;

revoke all on function public.rename_collection(uuid, text) from public, anon, authenticated;
revoke all on function public.reorder_collections(uuid[]) from public, anon, authenticated;
revoke all on function public.set_collection_cover(uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_video_captions(uuid, text) from public, anon, authenticated;
revoke all on function public.get_video_captions(uuid) from public, anon, authenticated;
grant execute on function public.rename_collection(uuid, text) to authenticated;
grant execute on function public.reorder_collections(uuid[]) to authenticated;
grant execute on function public.set_collection_cover(uuid, uuid) to authenticated;
grant execute on function public.set_video_captions(uuid, text) to authenticated;
grant execute on function public.get_video_captions(uuid) to authenticated;
