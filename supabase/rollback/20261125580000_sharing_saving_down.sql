-- Rollback for 20261125580000_sharing_saving.
-- DROPS DATA (flagged per Part 0): collection order/covers and saved video
-- captions are discarded. The posts TRUNCATE/TRIGGER/REFERENCES revoke is a
-- security fix and is deliberately NOT restored.

drop function if exists public.get_video_captions(uuid);
drop function if exists public.set_video_captions(uuid, text);
alter table public.posts drop column if exists video_captions;

drop function if exists public.set_collection_cover(uuid, uuid);
drop function if exists public.reorder_collections(uuid[]);
drop function if exists public.rename_collection(uuid, text);

create or replace function public.get_collections()
returns table (id uuid, name text, item_count bigint, cover_url text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.name,
    (select count(*) from public.bookmarks b where b.collection_id = c.id and b.user_id = auth.uid()),
    (select p.thumbnail_url from public.bookmarks b
       join public.posts p on p.id = b.post_id
       where b.collection_id = c.id and b.user_id = auth.uid()
       order by b.created_at desc limit 1),
    c.created_at
  from public.collections c
  where c.user_id = auth.uid()
  order by c.created_at desc;
$$;

alter table public.collections
  drop column if exists cover_post_id,
  drop column if exists position;
