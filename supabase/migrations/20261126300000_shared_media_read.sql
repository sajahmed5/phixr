-- Let viewers open the photos/videos of stories, story highlights and audience-group posts.
--
-- Signing a media URL (createSignedUrls) needs a storage.objects SELECT policy that matches
-- the key. `media_read` only covered public/private posts and their carousel extras, and
-- `media_read_message` covers DMs, so story, highlight and 'groups' post media could only
-- be opened by the person who posted it: everyone else got a broken image.
--
-- This adds one policy that reuses the existing visibility rules exactly:
--   * live stories      -> stories_select (expiry, can_see_stories, default/groups audience)
--   * highlight items   -> get_highlight_items (block check, default/groups audience)
--   * highlight covers  -> not blocked, and allowed to see the owner's stories
--   * 'groups' posts    -> posts_select's groups branch (+ the shared removed/blocked/
--                          sensitive-minor checks), for the post itself and its carousel items
-- Anonymous (web share) access is unchanged: groups/stories are never public.

create or replace function public.can_read_shared_media(_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    -- Live stories (same rule as the stories_select policy).
    exists (
      select 1 from public.stories s
      where (s.media_url = _key or s.thumbnail_url = _key)
        and s.expires_at > now()
        and public.can_see_stories(auth.uid(), s.user_id)
        and (s.user_id = auth.uid() or s.audience = 'default' or public.viewer_in_story_groups(s.id))
    )
    -- Highlight items (same rule as get_highlight_items).
    or exists (
      select 1
      from public.story_highlight_items i
      join public.story_highlights h on h.id = i.highlight_id
      where (i.media_url = _key or i.thumbnail_url = _key)
        and not public.is_blocked_with(h.user_id)
        and (
          h.user_id = auth.uid()
          or (i.audience = 'default' and public.can_see_stories(auth.uid(), h.user_id))
          or (i.audience = 'groups' and exists (
                select 1 from public.audience_group_members m
                where m.group_id = any (i.group_ids) and m.member_id = auth.uid()))
        )
    )
    -- Highlight covers (shown on the profile to anyone who may see the owner's stories).
    or exists (
      select 1 from public.story_highlights h
      where h.cover_url = _key
        and not public.is_blocked_with(h.user_id)
        and public.can_see_stories(auth.uid(), h.user_id)
    )
    -- Audience-group posts and their carousel items (posts_select's groups branch).
    or exists (
      select 1 from public.posts p
      where p.visibility = 'groups'
        and (
          p.media_url = _key or p.thumbnail_url = _key
          or exists (
            select 1 from public.post_media pm
            where pm.post_id = p.id and (pm.media_url = _key or pm.thumbnail_url = _key))
        )
        and not public.is_blocked_with(p.user_id)
        and p.moderation_status <> 'removed'
        and ((not p.sensitive) or (not public.is_minor(auth.uid())))
        and public.is_accepted_follower_of(p.user_id)
        and public.viewer_in_post_groups(p.id)
    );
$fn$;

revoke all on function public.can_read_shared_media(text) from public, anon;
grant execute on function public.can_read_shared_media(text) to authenticated;

drop policy if exists media_read_shared on storage.objects;
create policy media_read_shared on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and public.can_read_shared_media(name));
