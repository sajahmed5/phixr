-- Part 12A/12B: drafts and the post scheduler.
--
-- ONE table serves both: a draft is a saved composition; scheduling it just
-- sets status='scheduled' + a time. Media is pipeline-processed AT SAVE time
-- (so its moderation verdict is already known and publishing is instant);
-- caption text is checked with moderate_text AT SCHEDULE time, so a post is
-- never published unchecked and a held one tells the creator straight away
-- (brief 12B). A pg_cron job publishes due rows every minute.
--
-- Draft media lives in the private media bucket like all post media; the
-- payload only ever holds object keys, never public URLs.

insert into public.platform_settings (key, value, description, client_visible) values
  ('schedule_max_days',  to_jsonb(90),  'How far ahead a post can be scheduled (days).', true),
  ('schedule_max_posts', to_jsonb(100), 'Maximum simultaneously scheduled posts per account.', true),
  ('schedule_max_attempts', to_jsonb(3), 'Publish retries before a scheduled post is marked failed.', false)
on conflict (key) do nothing;

create table public.post_drafts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  kind         text not null default 'post' check (kind in ('post', 'story')),
  -- caption, alt_text, visibility, group_ids, tags[{name,source}], overlays,
  -- attach_location, location_cell, partner_brand, media[{media_url,
  -- thumbnail_url, media_type, moderation_status}], audience (stories)
  payload      jsonb not null default '{}'::jsonb,
  media_status text not null default 'pending'
               check (media_status in ('approved', 'flagged', 'pending', 'removed')),
  status       text not null default 'draft'
               check (status in ('draft', 'scheduled', 'held', 'publishing', 'published', 'failed')),
  scheduled_at timestamptz,
  published_post_id uuid references public.posts (id) on delete set null,
  failure_reason text,
  attempts     integer not null default 0,
  -- The rolling autosave slot (one per user per kind, replaced continuously).
  autosave     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index post_drafts_user on public.post_drafts (user_id, status, updated_at desc);
create index post_drafts_due on public.post_drafts (scheduled_at) where status = 'scheduled';
create unique index post_drafts_autosave on public.post_drafts (user_id, kind) where autosave;

alter table public.post_drafts enable row level security;
revoke all on table public.post_drafts from public, anon, authenticated;
grant select, insert, update, delete on table public.post_drafts to authenticated;
create policy post_drafts_own on public.post_drafts
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create trigger set_updated_at before update on public.post_drafts
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Notification types for Part 12 (one constraint change for the whole part).
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'new_follower','follow_request','follow_accepted',
    'comment','reply','comment_reaction','reach_milestone','moderation',
    'message','mention','like','report_update',
    'partnership_request','partnership_update',
    'schedule_update','collab_invite','collab_update'));

-- ---------------------------------------------------------------------------
-- Scheduling: limits + pre-publish text moderation (12B).
-- ---------------------------------------------------------------------------
create or replace function public.schedule_draft(_draft_id uuid, _when timestamptz)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d public.post_drafts;
  _max_days  integer := public.setting_numeric('schedule_max_days', 90)::integer;
  _max_posts integer := public.setting_numeric('schedule_max_posts', 100)::integer;
  _caption   text;
  _verdict   text;
begin
  select * into d from public.post_drafts
  where id = _draft_id and user_id = auth.uid() for update;
  if not found then raise exception 'not authorised'; end if;
  if d.status not in ('draft', 'scheduled', 'held', 'failed') then
    raise exception 'This draft cannot be scheduled.';
  end if;
  if _when < now() - interval '1 minute' then
    raise exception 'Pick a time in the future.';
  end if;
  if _when > now() + make_interval(days => _max_days) then
    raise exception 'You can schedule up to % days ahead.', _max_days;
  end if;
  if (select count(*) from public.post_drafts
      where user_id = auth.uid() and status = 'scheduled' and id <> _draft_id) >= _max_posts then
    raise exception 'You can have up to % scheduled posts.', _max_posts;
  end if;
  if coalesce(jsonb_array_length(d.payload->'media'), 0) = 0 then
    raise exception 'This draft has no media yet.';
  end if;
  if d.media_status = 'removed' then
    raise exception 'This media was rejected and cannot be posted.';
  end if;

  -- Moderation BEFORE the publish time (12B): media verdict is known from
  -- the pipeline; check the caption text now. Flagged either way → held,
  -- and the creator is told immediately.
  _caption := coalesce(d.payload->>'caption', '');
  _verdict := case when _caption = '' then 'approved'
                   else public.moderate_text(_caption) end;
  if d.media_status = 'flagged' or _verdict in ('flagged', 'removed') then
    update public.post_drafts
       set status = 'held', scheduled_at = _when,
           failure_reason = 'Held for review before publishing'
     where id = _draft_id;
    insert into public.notifications (user_id, type, payload)
    values (auth.uid(), 'schedule_update',
            jsonb_build_object('outcome', 'held', 'draft_id', _draft_id,
                               'scheduled_at', _when));
    return;
  end if;

  update public.post_drafts
     set status = 'scheduled', scheduled_at = _when, failure_reason = null, attempts = 0
   where id = _draft_id;
end;
$$;

create or replace function public.cancel_schedule(_draft_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.post_drafts
     set status = 'draft', scheduled_at = null, failure_reason = null, attempts = 0
   where id = _draft_id and user_id = auth.uid()
     and status in ('scheduled', 'held', 'failed');
  if not found then raise exception 'not authorised'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The publisher: every minute, publish due rows (12B, "accurate to within
-- one minute"). Runs as the job owner; each row is published atomically and
-- failures retry up to schedule_max_attempts with the reason recorded.
-- ---------------------------------------------------------------------------
create or replace function public._publish_one_draft(d public.post_drafts)
returns uuid
language plpgsql
volatile
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

  -- The pipeline verdict was captured at save time; stamp it explicitly
  -- (apply_pipeline_verdict finds nothing this late — verdicts are pruned).
  -- The zz text-moderation trigger still runs and may escalate; it never
  -- downgrades.
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

  -- Carousel extras.
  for _m in select * from jsonb_array_elements(d.payload->'media') offset 1 loop
    _pos := _pos + 1;
    insert into public.post_media (post_id, position, media_url, thumbnail_url, media_type)
    values (_post_id, _pos, _m->>'media_url', _m->>'thumbnail_url',
            coalesce(_m->>'media_type', 'image'));
  end loop;

  -- Audience groups ('groups' visibility is invisible until these land).
  for _gid in select jsonb_array_elements_text(coalesce(d.payload->'group_ids', '[]'::jsonb)) loop
    insert into public.post_audience_groups (post_id, group_id)
    values (_post_id, _gid::uuid) on conflict do nothing;
  end loop;

  -- Tags (find-or-create, provenance preserved).
  for _t in select * from jsonb_array_elements(coalesce(d.payload->'tags', '[]'::jsonb)) loop
    insert into public.tags (name) values (lower(_t->>'name'))
    on conflict (name) do update set name = excluded.name
    returning id into _tag_id;
    insert into public.post_tags (post_id, tag_id, source)
    values (_post_id, _tag_id,
            case when _t->>'source' in ('user','vision','geo') then _t->>'source' else 'user' end)
    on conflict do nothing;
  end loop;

  -- Paid partnership (9A): declared at publish, same rules as the live path.
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
volatile
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
        -- Retry on the next minute tick.
        update public.post_drafts
           set status = 'scheduled', attempts = d.attempts + 1, failure_reason = sqlerrm
         where id = d.id;
      end if;
    end;
  end loop;
end;
$$;

select cron.schedule('publish-scheduled', '* * * * *', $$select public.publish_due_drafts();$$)
where not exists (select 1 from cron.job where jobname = 'publish-scheduled');

-- Grants (default privileges no longer hand out EXECUTE — explicit only).
revoke all on function public.schedule_draft(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.cancel_schedule(uuid) from public, anon, authenticated;
revoke all on function public._publish_one_draft(public.post_drafts) from public, anon, authenticated;
revoke all on function public.publish_due_drafts() from public, anon, authenticated;
grant execute on function public.schedule_draft(uuid, timestamptz) to authenticated;
grant execute on function public.cancel_schedule(uuid) to authenticated;
