-- ============================================================================
-- 20261127090000_post_location_label
--
-- Feedback #61/#65: a post's picked place was stored only as a coarse cell
-- (posts.location_cell), so there was nothing human-readable to SHOW — the
-- viewer and the deck card could never say where a post was tagged. Store the
-- display label the reporter picked ("Camden Market", "York") alongside the
-- cell. Still no raw coordinates; the label is the name the user chose from
-- the picker, written only when they opted in to attaching location.
-- ============================================================================

alter table public.posts
  add column if not exists location_label text
    check (location_label is null or length(btrim(location_label)) between 1 and 120);

-- Clients may set it at post time, same as location_cell. Column-level insert
-- grants fail closed, so the new column needs its own (see the #19 postmortem:
-- a missing per-column grant breaks the whole insert).
grant insert (location_label) on public.posts to authenticated;
-- Owners may fix or clear the label from the edit screen later.
grant update (location_label) on public.posts to authenticated;
