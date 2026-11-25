-- Part 17 security review: fixes for everything the final sweep found.
--
-- 1. ad_accounts.balance_pence and status were CLIENT-WRITABLE (insert and
--    update) — an advertiser could credit their own ad balance or unpause a
--    paused account. Balance moves only via server-side billing; status is
--    the platform's.
-- 2. ad_sets.audience_validated_at was client-writable — an advertiser could
--    stamp a sub-50-person audience as validated, bypassing the privacy
--    floor. Also: changing audience_kind or engaged_days after validation
--    kept the old stamp; now any such change clears it (re-validate).
-- 3. comments had a direct INSERT path that skipped add_comment's hidden
--    words, limits and moderation.
-- 4. swipes had direct INSERT/DELETE paths skipping record_swipe's rules
--    (groups-post refusal) and undo_swipe's accounting.
-- 5. The scheduler trusted the CLIENT-written post_drafts.media_status: a
--    forged draft could publish flagged (or someone else's) media as an
--    approved post. A trigger now locks a server_media_status in from
--    pipeline_verdicts (keyed by media + OWNER) whenever a draft's media is
--    saved; publishing trusts only that plus a fresh caption moderation —
--    anything not clean is HELD, and posts get their moderation_status from
--    the server verdict, never the draft.
-- 6. Hygiene: dead write grants on tables whose RLS has no write policies
--    (venues, pipeline_verdicts, handle_history, media_upload_events,
--    places_events) are revoked outright.

-- 1. ad_accounts ------------------------------------------------------------
revoke insert, update on table public.ad_accounts from authenticated;
grant insert (user_id, business_name, vat_number, country) on public.ad_accounts to authenticated;
grant update (business_name, vat_number, country) on public.ad_accounts to authenticated;

-- 2. ad_sets ----------------------------------------------------------------
revoke insert, update on table public.ad_sets from authenticated;
grant insert (campaign_id, name, age_bands, region_label, tag_ids, placements,
              pricing_model, budget_daily_pence, budget_total_pence, starts_at,
              ends_at, status, audience_kind, engaged_days, avoid_sensitive,
              blocked_topics, blocked_creators)
  on public.ad_sets to authenticated;
grant update (name, age_bands, region_label, tag_ids, placements, pricing_model,
              budget_daily_pence, budget_total_pence, starts_at, ends_at, status,
              audience_kind, engaged_days, avoid_sensitive, blocked_topics,
              blocked_creators)
  on public.ad_sets to authenticated;

-- Changing what the audience IS invalidates its validation.
create or replace function public.tg_ad_sets_revalidate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.audience_kind is distinct from old.audience_kind
     or new.engaged_days is distinct from old.engaged_days then
    new.audience_validated_at := null;
  end if;
  return new;
end;
$$;
create trigger aa_ad_sets_revalidate before update on public.ad_sets
  for each row execute function public.tg_ad_sets_revalidate();
revoke all on function public.tg_ad_sets_revalidate() from public, anon, authenticated;

-- 3. comments: writes go through add_comment (definer) only ------------------
revoke insert on table public.comments from authenticated;

-- 4. swipes: record_swipe / undo_swipe (definer) only ------------------------
revoke insert, delete on table public.swipes from authenticated;

-- 5. publishing trusts only a SERVER-written verdict --------------------------
-- pipeline_verdicts are pruned after ~24h while drafts can sit for 90 days,
-- so the verdict is LOCKED IN when the draft's media is saved: a trigger
-- writes post_drafts.server_media_status from pipeline_verdicts (keyed by
-- media AND owner — the draft owner or the signed-in team editor), and
-- clients cannot write that column (nor undo it: the trigger reverts client
-- attempts). fame-admin's queue approval (service role) may overwrite it.

alter table public.post_drafts
  add column server_media_status text not null default 'pending'
    check (server_media_status in ('approved', 'pending', 'flagged', 'removed'));
-- One-time backfill: existing drafts predate forgery concerns.
update public.post_drafts set server_media_status = media_status;

create or replace function public.tg_post_drafts_verdict()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _m jsonb;
  _v text;
  _worst text := 'approved';
begin
  if tg_op = 'INSERT'
     or (new.payload->'media') is distinct from (old.payload->'media') then
    -- Media (re)attached: compute the verdict NOW, while pipeline verdicts
    -- are fresh. A key with no verdict for this owner/editor was never
    -- cleared by the pipeline → flagged (admin can approve from the queue).
    for _m in select * from jsonb_array_elements(coalesce(new.payload->'media', '[]'::jsonb)) loop
      select pv.moderation_status into _v
      from public.pipeline_verdicts pv
      where pv.media_key = _m->>'media_url'
        and (pv.owner_id = new.user_id or pv.owner_id = auth.uid())
      order by pv.created_at desc limit 1;
      _v := coalesce(_v, 'flagged');
      if _v = 'removed' then _worst := 'removed';
      elsif _v = 'flagged' and _worst <> 'removed' then _worst := 'flagged';
      elsif _v = 'pending' and _worst = 'approved' then _worst := 'pending';
      end if;
    end loop;
    new.server_media_status := _worst;
  elsif tg_op = 'UPDATE'
        and new.server_media_status is distinct from old.server_media_status
        and coalesce(auth.role(), 'service_role') in ('authenticated', 'anon') then
    -- Clients never set the server verdict; service role / jobs / admin may.
    new.server_media_status := old.server_media_status;
  end if;
  return new;
end;
$$;
create trigger aa_post_drafts_verdict before insert or update on public.post_drafts
  for each row execute function public.tg_post_drafts_verdict();
revoke all on function public.tg_post_drafts_verdict() from public, anon, authenticated;

-- Clients keep exactly the columns the app writes; status transitions,
-- scheduling and the server verdict stay with the RPCs and triggers.
revoke insert, update on table public.post_drafts from authenticated;
grant insert (user_id, kind, payload, media_status, autosave) on public.post_drafts to authenticated;
grant update (user_id, kind, payload, media_status, autosave) on public.post_drafts to authenticated;

-- The authoritative publish-time verdict:
--   'held'     → never publish (flagged/removed media, flagged caption, or a
--                story whose media isn't cleanly approved)
--   'pending'  → publish posts invisible (moderation_status 'pending')
--   'approved' → publish normally
create or replace function public._draft_server_verdict(d public.post_drafts)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if d.server_media_status in ('flagged', 'removed') then return 'held'; end if;
  if public.moderate_text(coalesce(d.payload->>'caption', '')) <> 'approved' then
    return 'held';
  end if;
  -- Stories have no review queue: anything not cleanly approved is held.
  if d.kind = 'story' and d.server_media_status <> 'approved' then return 'held'; end if;
  return d.server_media_status;
end;
$$;
revoke all on function public._draft_server_verdict(public.post_drafts) from public, anon, authenticated;

-- _publish_one_draft v2: posts carry the SERVER verdict, never d.media_status.
-- (Everything else is the Part 12 body, verbatim.)
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
  _verdict text;
begin
  _cover := d.payload->'media'->0;
  if _cover is null then raise exception 'draft has no media'; end if;

  -- Part 17: the server decides the moderation state (see _draft_server_verdict).
  _verdict := public._draft_server_verdict(d);
  if _verdict = 'held' then
    raise exception 'Held for review before publishing';
  end if;

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
          _verdict)
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

-- publish_due_drafts v2: a held verdict parks the draft as 'held' (with the
-- Part 12 notification) instead of burning retry attempts.
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
      -- Part 17: server-side verdict first — held drafts never publish.
      if public._draft_server_verdict(d) = 'held' then
        update public.post_drafts
           set status = 'held', failure_reason = 'Held for review before publishing'
         where id = d.id;
        insert into public.notifications (user_id, type, payload)
        values (d.user_id, 'schedule_update',
                jsonb_build_object('outcome', 'held', 'kind', d.kind, 'draft_id', d.id));
        continue;
      end if;

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

-- 6. hygiene: dead write grants on no-write-policy tables ---------------------
revoke insert, update, delete on table public.venues from authenticated;
revoke insert, update, delete on table public.pipeline_verdicts from anon, authenticated;
revoke insert, update, delete on table public.handle_history from anon, authenticated;
revoke update, delete on table public.media_upload_events from authenticated;
revoke update, delete on table public.places_events from authenticated;
