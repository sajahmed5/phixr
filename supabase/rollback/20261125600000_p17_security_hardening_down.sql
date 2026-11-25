-- Rollback for 20261125600000_p17_security_hardening.
-- WARNING: this RESTORES the vulnerable pre-Part-17 state (client-writable
-- ad balance, audience stamp, direct comment/swipe writes, client-trusted
-- draft moderation). Only for emergency compatibility rollback.

-- 1/2: broad grants back
grant insert, update on table public.ad_accounts to authenticated;
grant insert, update on table public.ad_sets to authenticated;
drop trigger if exists aa_ad_sets_revalidate on public.ad_sets;
drop function if exists public.tg_ad_sets_revalidate();

-- 3/4
grant insert on table public.comments to authenticated;
grant insert, delete on table public.swipes to authenticated;

-- 5: drop the server verdict machinery and restore the Part 12 fns verbatim
drop trigger if exists aa_post_drafts_verdict on public.post_drafts;
drop function if exists public.tg_post_drafts_verdict();
drop function if exists public._draft_server_verdict(public.post_drafts);
grant insert, update on table public.post_drafts to authenticated;
alter table public.post_drafts drop column if exists server_media_status;

create or replace function public._publish_one_draft(d public.post_drafts)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  _post_id uuid;
  _story_id uuid;
  _m jsonb;
  _cover jsonb;
  _t jsonb;
  _tag_id uuid;
  _gid text;
  _pos integer := 0;
  _brand public.profiles;
begin
  _cover := d.payload->'media'->0;
  if _cover is null then raise exception 'draft has no media'; end if;

  if d.kind = 'story' then
    insert into public.stories (user_id, media_url, thumbnail_url, media_type, audience)
    values (d.user_id, _cover->>'media_url', _cover->>'thumbnail_url',
            coalesce(_cover->>'media_type', 'image'),
            case when d.payload->>'audience' = 'groups' then 'groups' else 'default' end)
    returning id into _story_id;
    for _gid in select jsonb_array_elements_text(coalesce(d.payload->'group_ids', '[]'::jsonb)) loop
      insert into public.story_audience_groups (story_id, group_id)
      values (_story_id, _gid::uuid) on conflict do nothing;
    end loop;
    return _story_id;
  end if;

  insert into public.posts (user_id, media_url, thumbnail_url, media_type, caption,
                            alt_text, visibility, location_cell, overlays, moderation_status)
  values (d.user_id, _cover->>'media_url', _cover->>'thumbnail_url',
          coalesce(_cover->>'media_type', 'image'),
          nullif(d.payload->>'caption', ''),
          nullif(d.payload->>'alt_text', ''),
          coalesce(d.payload->>'visibility', 'public'),
          case when coalesce((d.payload->>'attach_location')::boolean, false)
               then d.payload->>'location_cell' end,
          coalesce(d.payload->'overlays', '[]'::jsonb),
          d.media_status)
  returning id into _post_id;

  for _m in select * from jsonb_array_elements(d.payload->'media') offset 1 loop
    _pos := _pos + 1;
    insert into public.post_media (post_id, position, media_url, thumbnail_url, media_type)
    values (_post_id, _pos, _m->>'media_url', _m->>'thumbnail_url',
            coalesce(_m->>'media_type', 'image'));
  end loop;

  for _gid in select jsonb_array_elements_text(coalesce(d.payload->'group_ids', '[]'::jsonb)) loop
    insert into public.post_audience_groups (post_id, group_id)
    values (_post_id, _gid::uuid) on conflict do nothing;
  end loop;

  for _t in select * from jsonb_array_elements(coalesce(d.payload->'tags', '[]'::jsonb)) loop
    insert into public.tags (name) values (lower(_t->>'name'))
    on conflict (name) do update set name = excluded.name
    returning id into _tag_id;
    insert into public.post_tags (post_id, tag_id, source)
    values (_post_id, _tag_id,
            case when _t->>'source' in ('user','vision','geo') then _t->>'source' else 'user' end)
    on conflict do nothing;
  end loop;

  if nullif(btrim(coalesce(d.payload->>'partner_brand', '')), '') is not null then
    select * into _brand from public.profiles
    where lower(handle) = lower(ltrim(btrim(d.payload->>'partner_brand'), '@'));
    if found and _brand.account_type = 'business' and _brand.id <> d.user_id
       and not public.is_minor(d.user_id) then
      insert into public.post_partnerships (post_id, creator_id, brand_id)
      values (_post_id, d.user_id, _brand.id)
      on conflict do nothing;
      insert into public.notifications (user_id, type, actor_id, post_id, payload)
      select _brand.id, 'partnership_request', d.user_id, _post_id,
             jsonb_build_object('actor_handle', pr.handle, 'actor_name', pr.display_name)
      from public.profiles pr where pr.id = d.user_id;
    end if;
  end if;

  return _post_id;
end;
$$;

create or replace function public.publish_due_drafts()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.post_drafts;
  _id uuid;
  _max_attempts integer := public.setting_numeric('schedule_max_attempts', 3)::integer;
begin
  for d in
    select * from public.post_drafts
    where status = 'scheduled' and scheduled_at <= now()
    order by scheduled_at
    limit 50
    for update skip locked
  loop
    begin
      update public.post_drafts set status = 'publishing' where id = d.id;
      _id := public._publish_one_draft(d);
      update public.post_drafts
         set status = 'published',
             published_post_id = case when d.kind = 'post' then _id end
       where id = d.id;
      insert into public.notifications (user_id, type, post_id, payload)
      values (d.user_id, 'schedule_update',
              case when d.kind = 'post' then _id end,
              jsonb_build_object('outcome', 'published', 'kind', d.kind));
    exception when others then
      if d.attempts + 1 >= _max_attempts then
        update public.post_drafts
           set status = 'failed', attempts = d.attempts + 1, failure_reason = sqlerrm
         where id = d.id;
        insert into public.notifications (user_id, type, payload)
        values (d.user_id, 'schedule_update',
                jsonb_build_object('outcome', 'failed', 'kind', d.kind,
                                   'reason', sqlerrm, 'draft_id', d.id));
      else
        update public.post_drafts
           set status = 'scheduled', attempts = d.attempts + 1, failure_reason = sqlerrm
         where id = d.id;
      end if;
    end;
  end loop;
end;
$$;

-- 6: dead grants back (they were inert — no write policies — but restored
-- for byte-exact parity)
grant insert, update, delete on table public.venues to authenticated;
grant insert, update, delete on table public.pipeline_verdicts to authenticated;
grant insert, update, delete on table public.handle_history to authenticated;
grant update, delete on table public.media_upload_events to authenticated;
grant update, delete on table public.places_events to authenticated;
