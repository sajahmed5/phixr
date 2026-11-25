-- Rollback for 20261125440000_profile_showcase.
drop function if exists public.record_link_tap(uuid);
drop function if exists public.add_profile_link(text, text);
drop function if exists public.get_highlight_items(uuid);
drop function if exists public.get_highlights(uuid);
drop function if exists public.remove_highlight_item(uuid, text);
drop function if exists public.add_story_to_highlight(uuid, uuid);
drop function if exists public.set_post_pinned(uuid, boolean);
drop table if exists public.profile_links;
drop table if exists public.link_domain_blocklist;
drop table if exists public.story_highlight_items;
drop table if exists public.story_highlights;
alter table public.posts drop column if exists pinned_at;
alter table public.profiles drop column if exists category;  -- flagged: drops user data (category labels)
delete from public.platform_settings where key in
  ('post_pins_max', 'profile_links_max', 'profile_links_minors_blocked', 'highlight_items_max');
