-- Part 13A: team access for business / advertiser accounts.
--
-- Team members use their OWN logins. Roles:
--   admin     — everything, including billing and the team itself
--   editor    — posts, ads, schedules (no billing, no team)
--   analyst   — reports read-only
--   moderator — comments and DMs only
-- Every ads-manager mutation is captured in ads_activity_log by TRIGGERS
-- (so the log can't be skipped by a client). Removal takes effect
-- immediately: every check reads team_members live.
--
-- In-app delegation (signed off): editors create/schedule the business's
-- posts THROUGH THE PART 12 SCHEDULER (published server-side as the
-- business); moderators/editors read business DMs and reply AS the business
-- (the customer sees the business; the log records the real sender).

create table public.team_members (
  business_id uuid not null references public.profiles (id) on delete cascade,
  member_id   uuid not null references public.profiles (id) on delete cascade,
  role        text not null check (role in ('admin', 'editor', 'analyst', 'moderator')),
  status      text not null default 'pending' check (status in ('pending', 'accepted')),
  invited_by  uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  constraint team_not_self check (business_id <> member_id),
  primary key (business_id, member_id)
);
create index team_members_member on public.team_members (member_id, status);

alter table public.team_members enable row level security;
revoke all on table public.team_members from public, anon, authenticated;
grant select on table public.team_members to authenticated;
-- Both sides see the rows they're part of; management goes through functions.
create policy team_members_select on public.team_members
  for select to authenticated
  using (business_id = auth.uid() or member_id = auth.uid()
         or exists (select 1 from public.team_members t2
                    where t2.business_id = team_members.business_id
                      and t2.member_id = auth.uid()
                      and t2.status = 'accepted' and t2.role = 'admin'));

-- THE check every delegated path uses. Live read → removal is instant.
create or replace function public.has_team_role(_business uuid, _roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select _business = auth.uid()  -- the account owner has every role
      or exists (select 1 from public.team_members t
                 where t.business_id = _business and t.member_id = auth.uid()
                   and t.status = 'accepted' and t.role = any (_roles));
$$;

create or replace function public.invite_team_member(_business uuid, _who text, _role text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _invitee uuid;
begin
  if _role not in ('admin', 'editor', 'analyst', 'moderator') then
    raise exception 'bad role';
  end if;
  if not public.has_team_role(_business, array['admin']) then
    raise exception 'not authorised';
  end if;
  -- _who is a handle or an email (emails resolved server-side only).
  select pr.id into _invitee from public.profiles pr
  where lower(pr.handle) = lower(ltrim(btrim(_who), '@'));
  if _invitee is null then
    select u.id into _invitee from auth.users u
    where lower(u.email) = lower(btrim(_who))
      and exists (select 1 from public.profiles pr where pr.id = u.id);
  end if;
  if _invitee is null then raise exception 'No Phixr account found for that handle or email.'; end if;
  if _invitee = _business then raise exception 'That is the business account itself.'; end if;
  if public.is_minor(_invitee) then raise exception 'Team members must be over 18.'; end if;

  insert into public.team_members (business_id, member_id, role, invited_by)
  values (_business, _invitee, _role, auth.uid())
  on conflict (business_id, member_id)
  do update set role = excluded.role where team_members.status = 'pending';

  insert into public.notifications (user_id, type, actor_id, payload)
  select _invitee, 'team_invite', _business,
         jsonb_build_object('business_handle', pr.handle, 'role', _role)
  from public.profiles pr where pr.id = _business;
end;
$$;

create or replace function public.respond_team_invite(_business uuid, _accept boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if _accept then
    update public.team_members
       set status = 'accepted', decided_at = now()
     where business_id = _business and member_id = auth.uid() and status = 'pending';
    if not found then raise exception 'not authorised'; end if;
  else
    delete from public.team_members
     where business_id = _business and member_id = auth.uid() and status = 'pending';
    if not found then raise exception 'not authorised'; end if;
  end if;
end;
$$;

create or replace function public.remove_team_member(_business uuid, _member uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- Admins remove anyone; a member may remove themself.
  if not (public.has_team_role(_business, array['admin']) or _member = auth.uid()) then
    raise exception 'not authorised';
  end if;
  delete from public.team_members where business_id = _business and member_id = _member;
  if not found then raise exception 'no such member'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Activity log: trigger-written (clients cannot skip it), readable by the
-- team's admins and the owner.
-- ---------------------------------------------------------------------------
create table public.ads_activity_log (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  actor_id    uuid,
  action      text not null,
  entity      text not null,
  entity_id   uuid,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index ads_activity_log_biz on public.ads_activity_log (business_id, created_at desc);
alter table public.ads_activity_log enable row level security;
revoke all on table public.ads_activity_log from public, anon, authenticated;
grant select on table public.ads_activity_log to authenticated;
create policy ads_activity_log_select on public.ads_activity_log
  for select to authenticated
  using (public.has_team_role(business_id, array['admin']));

create or replace function public.tg_ads_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _biz uuid;
  _entity text := tg_table_name;
  _id uuid;
begin
  if tg_table_name = 'campaigns' then
    _biz := coalesce(new.account_id, old.account_id);
    _id := coalesce(new.id, old.id);
  elsif tg_table_name = 'ad_sets' then
    select c.account_id into _biz from public.campaigns c
    where c.id = coalesce(new.campaign_id, old.campaign_id);
    _id := coalesce(new.id, old.id);
  elsif tg_table_name = 'ads' then
    select c.account_id into _biz
    from public.ad_sets s join public.campaigns c on c.id = s.campaign_id
    where s.id = coalesce(new.ad_set_id, old.ad_set_id);
    _id := coalesce(new.id, old.id);
  end if;
  if _biz is not null then
    insert into public.ads_activity_log (business_id, actor_id, action, entity, entity_id, detail)
    values (_biz, auth.uid(), lower(tg_op), _entity, _id,
            case when tg_op = 'UPDATE' and tg_table_name <> 'ads'
                 then jsonb_build_object('status', to_jsonb(new) ->> 'status')
                 else '{}'::jsonb end);
  end if;
  return coalesce(new, old);
end;
$$;
create trigger zz_log_campaigns after insert or update or delete on public.campaigns
  for each row execute function public.tg_ads_activity();
create trigger zz_log_ad_sets after insert or update or delete on public.ad_sets
  for each row execute function public.tg_ads_activity();
create trigger zz_log_ads after insert or update or delete on public.ads
  for each row execute function public.tg_ads_activity();

-- ---------------------------------------------------------------------------
-- Ads-manager RLS extended to teams (owner checks become has_team_role).
--   read: any accepted team member; writes: admin/editor; billing: admin.
-- ---------------------------------------------------------------------------
drop policy if exists ad_accounts_own on public.ad_accounts;
create policy ad_accounts_select on public.ad_accounts
  for select to authenticated
  using (public.has_team_role(user_id, array['admin','editor','analyst','moderator']));
create policy ad_accounts_insert on public.ad_accounts
  for insert to authenticated with check (user_id = auth.uid());
create policy ad_accounts_update on public.ad_accounts
  for update to authenticated
  using (public.has_team_role(user_id, array['admin']))
  with check (public.has_team_role(user_id, array['admin']));

drop policy if exists campaigns_own on public.campaigns;
create policy campaigns_select on public.campaigns
  for select to authenticated
  using (public.has_team_role(account_id, array['admin','editor','analyst','moderator']));
create policy campaigns_write on public.campaigns
  for all to authenticated
  using (public.has_team_role(account_id, array['admin','editor']))
  with check (public.has_team_role(account_id, array['admin','editor']));

drop policy if exists ad_sets_own on public.ad_sets;
create policy ad_sets_select on public.ad_sets
  for select to authenticated
  using (exists (select 1 from public.campaigns c where c.id = campaign_id
                 and public.has_team_role(c.account_id, array['admin','editor','analyst','moderator'])));
create policy ad_sets_write on public.ad_sets
  for all to authenticated
  using (exists (select 1 from public.campaigns c where c.id = campaign_id
                 and public.has_team_role(c.account_id, array['admin','editor'])))
  with check (exists (select 1 from public.campaigns c where c.id = campaign_id
                 and public.has_team_role(c.account_id, array['admin','editor'])));

drop policy if exists ads_own on public.ads;
create policy ads_select on public.ads
  for select to authenticated
  using (exists (select 1 from public.ad_sets s join public.campaigns c on c.id = s.campaign_id
                 where s.id = ad_set_id
                 and public.has_team_role(c.account_id, array['admin','editor','analyst','moderator'])));
create policy ads_write on public.ads
  for all to authenticated
  using (exists (select 1 from public.ad_sets s join public.campaigns c on c.id = s.campaign_id
                 where s.id = ad_set_id
                 and public.has_team_role(c.account_id, array['admin','editor'])))
  with check (exists (select 1 from public.ad_sets s join public.campaigns c on c.id = s.campaign_id
                 where s.id = ad_set_id
                 and public.has_team_role(c.account_id, array['admin','editor'])));

drop policy if exists ad_charges_own_select on public.ad_charges;
create policy ad_charges_select on public.ad_charges
  for select to authenticated
  using (public.has_team_role(account_id, array['admin']));

-- get_ad_report v2: verbatim Part 8 body, auth line opened to the team.
create or replace function public.get_ad_report(_ad_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  _floor integer := public.setting_numeric('min_aggregate_group_size', 50)::integer;
  _post uuid;
  _views bigint := 0; _quick bigint := 0; _dwell bigint := 0;
  _video bigint := 0; _comp bigint := 0;
  _likes integer; _skips integer; _total integer;
  _clicks integer; _spend bigint;
  _dropoff jsonb := '[]'::jsonb; _peak integer;
  _bands jsonb := '[]'::jsonb; _regions jsonb := '[]'::jsonb; _interests jsonb := '[]'::jsonb;
  _tip text; _like_rate numeric; _quick_rate numeric; _completion numeric;
  p public.posts;
begin
  select a.post_id into _post
  from public.ads a
  join public.ad_sets s on s.id = a.ad_set_id
  join public.campaigns c on c.id = s.campaign_id
  where a.id = _ad_id
    -- Part 13A: the whole team can read reports (analyst and up).
    and public.has_team_role(c.account_id, array['admin','editor','analyst','moderator']);
  if _post is null then
    raise exception 'not authorised';
  end if;
  select * into p from public.posts where id = _post;

  select greatest(p.like_count - coalesce(bc.bot_like_count, 0), 0),
         greatest(p.skip_count - coalesce(bc.bot_skip_count, 0), 0)
    into _likes, _skips
  from (select 1) one
  left join public.post_bot_counts bc on bc.post_id = _post;
  _total := _likes + _skips;
  _like_rate := case when _total > 0 then _likes::numeric / _total end;

  select coalesce(sum(s.views),0), coalesce(sum(s.quick_skips),0), coalesce(sum(s.dwell_ms_sum),0),
         coalesce(sum(s.video_views),0), coalesce(sum(s.completions),0)
    into _views, _quick, _dwell, _video, _comp
  from public.post_daily_stats s where s.post_id = _post;
  _quick_rate := case when _views > 0 then _quick::numeric / _views end;
  _completion := case when _video > 0 then _comp::numeric / _video end;

  if _video > 0 then
    with stops as (
      select (kv.key)::integer as sec, sum((kv.value)::numeric)::bigint as n
      from public.post_daily_stats s, lateral jsonb_each_text(s.stop_positions) kv
      where s.post_id = _post group by 1
    ),
    curve as (
      select st.sec,
             (_video - coalesce(sum(st.n) over (order by st.sec rows between unbounded preceding and 1 preceding), 0))::bigint as watching,
             st.n
      from stops st
    )
    select coalesce(jsonb_agg(jsonb_build_object('sec', c2.sec, 'watching', c2.watching) order by c2.sec), '[]'::jsonb),
           (select c3.sec from curve c3 order by c3.n desc, c3.sec limit 1)
      into _dropoff, _peak
    from curve c2;
  end if;

  select count(*) into _clicks from public.ad_clicks k where k.ad_id = _ad_id;
  select coalesce(-sum(ch.amount_pence), 0) into _spend
  from public.ad_charges ch where ch.ad_id = _ad_id and ch.amount_pence < 0;

  -- Audience: ADULT likers only (minors never in advertiser data), 50-floor.
  with banded as (
    select case
             when extract(year from age((now() at time zone 'Europe/London')::date, pr.date_of_birth)) < 25 then '18-24'
             when extract(year from age((now() at time zone 'Europe/London')::date, pr.date_of_birth)) < 35 then '25-34'
             when extract(year from age((now() at time zone 'Europe/London')::date, pr.date_of_birth)) < 45 then '35-44'
             when extract(year from age((now() at time zone 'Europe/London')::date, pr.date_of_birth)) < 55 then '45-54'
             else '55+'
           end as band,
           pr.search_center_label as region, pr.id as uid
    from public.swipes sw
    join public.profiles pr on pr.id = sw.user_id
    where sw.post_id = _post and sw.direction = 'right'
      and pr.age_band = 'adult'
      and pr.date_of_birth is not null
  ),
  bc as (select band, count(*)::integer as n from banded group by band),
  bf as (select case when n >= _floor then band else 'Other' end as band, sum(n)::integer as n
         from bc group by 1),
  rc as (select region, count(*)::integer as n from banded where region is not null group by region),
  rf as (select case when n >= _floor then region else 'Other' end as region, sum(n)::integer as n
         from rc group by 1),
  ic as (select t.name as tag, count(distinct b.uid)::integer as n
         from banded b
         join public.user_tags ut on ut.user_id = b.uid and ut.weight > 0
         join public.tags t on t.id = ut.tag_id
         group by t.name having count(distinct b.uid) >= _floor
         order by 2 desc limit 5)
  select
    coalesce((select jsonb_agg(jsonb_build_object('band', band, 'likes', n) order by n desc) from bf), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('region', region, 'likes', n) order by n desc) from rf), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('tag', tag, 'likes', n) order by n desc) from ic), '[]'::jsonb)
    into _bands, _regions, _interests;

  _tip := public._pick_tip(_quick_rate, _completion, _like_rate, null, null);

  return jsonb_build_object(
    'views', _views,
    'right_swipes', _likes,
    'left_swipes', _skips,
    'like_rate', _like_rate,
    'quick_skip_rate', _quick_rate,
    'avg_dwell_ms', case when _views > 0 then round(_dwell::numeric / _views) end,
    'completion_rate', _completion,
    'dropoff', _dropoff,
    'dropoff_peak_sec', _peak,
    'clicks', _clicks,
    'spend_pence', _spend,
    'cost_per_like_pence', case when _likes > 0 then round(_spend::numeric / _likes, 1) end,
    'cost_per_click_pence', case when _clicks > 0 then round(_spend::numeric / _clicks, 1) end,
    'audience', jsonb_build_object('age_bands', _bands, 'regions', _regions, 'interests', _interests),
    'tip', _tip
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- In-app delegation.
-- ---------------------------------------------------------------------------
-- DM read: team moderators/admins/editors see the BUSINESS's conversations.
create or replace function public.is_conversation_member(_cid uuid, _uid uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (select 1 from public.conversation_members m
                 where m.conversation_id = _cid
                   and (m.user_id = _uid
                        -- Part 13A: a business's team can work its inbox.
                        or exists (select 1 from public.team_members t
                                   where t.member_id = _uid and t.status = 'accepted'
                                     and t.role in ('admin','editor','moderator')
                                     and t.business_id = m.user_id)));
$fn$;

-- Reply AS the business (customer sees the business; the log records who).
create or replace function public.send_message_as_business(_business uuid, _cid uuid, _body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _mid uuid;
  _clean text := btrim(_body);
begin
  if not public.has_team_role(_business, array['admin','editor','moderator']) then
    raise exception 'not authorised';
  end if;
  if not exists (select 1 from public.conversation_members m
                 where m.conversation_id = _cid and m.user_id = _business) then
    raise exception 'not authorised';
  end if;
  if char_length(_clean) = 0 or char_length(_clean) > 2000 then
    raise exception 'bad message';
  end if;
  insert into public.messages (conversation_id, sender_id, body)
  values (_cid, _business, _clean)
  returning id into _mid;
  insert into public.ads_activity_log (business_id, actor_id, action, entity, entity_id)
  values (_business, auth.uid(), 'dm_reply', 'messages', _mid);
  return _mid;
end;
$$;

-- The business's conversation list for team members.
create or replace function public.get_business_conversations(_business uuid)
returns table (conversation_id uuid, other_handle text, other_display_name text,
               last_body text, last_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select m.conversation_id, pr.handle, pr.display_name,
         (select msg.body from public.messages msg
          where msg.conversation_id = m.conversation_id
          order by msg.created_at desc limit 1),
         (select max(msg.created_at) from public.messages msg
          where msg.conversation_id = m.conversation_id)
  from public.conversation_members m
  join public.conversation_members o
    on o.conversation_id = m.conversation_id and o.user_id <> m.user_id
  join public.profiles pr on pr.id = o.user_id
  where m.user_id = _business
    and public.has_team_role(_business, array['admin','editor','moderator'])
  order by 5 desc nulls last
  limit 100;
$$;

-- Business posting through the Part 12 scheduler: an editor saves/schedules
-- drafts OWNED BY THE BUSINESS; the cron publishes them as the business.
create or replace function public.save_business_draft(_business uuid, _payload jsonb, _media_status text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare _id uuid;
begin
  if not public.has_team_role(_business, array['admin','editor']) then
    raise exception 'not authorised';
  end if;
  if _media_status not in ('approved','flagged','pending','removed') then
    raise exception 'bad media status';
  end if;
  insert into public.post_drafts (user_id, kind, payload, media_status)
  values (_business, 'post', _payload, _media_status)
  returning id into _id;
  insert into public.ads_activity_log (business_id, actor_id, action, entity, entity_id)
  values (_business, auth.uid(), 'draft_create', 'post_drafts', _id);
  return _id;
end;
$$;

create or replace function public.schedule_business_draft(_business uuid, _draft_id uuid, _when timestamptz)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  d public.post_drafts;
  _max_days  integer := public.setting_numeric('schedule_max_days', 90)::integer;
  _verdict   text;
begin
  if not public.has_team_role(_business, array['admin','editor']) then
    raise exception 'not authorised';
  end if;
  select * into d from public.post_drafts
  where id = _draft_id and user_id = _business for update;
  if not found then raise exception 'not authorised'; end if;
  if _when > now() + make_interval(days => _max_days) then
    raise exception 'You can schedule up to % days ahead.', _max_days;
  end if;
  if coalesce(jsonb_array_length(d.payload->'media'), 0) = 0 then
    raise exception 'This draft has no media yet.';
  end if;
  _verdict := case when coalesce(d.payload->>'caption','') = '' then 'approved'
                   else public.moderate_text(d.payload->>'caption') end;
  if d.media_status = 'flagged' or _verdict in ('flagged','removed') then
    update public.post_drafts set status = 'held', scheduled_at = _when,
           failure_reason = 'Held for review before publishing' where id = _draft_id;
  else
    update public.post_drafts set status = 'scheduled', scheduled_at = _when,
           failure_reason = null, attempts = 0 where id = _draft_id;
  end if;
  insert into public.ads_activity_log (business_id, actor_id, action, entity, entity_id,
                                       detail)
  values (_business, auth.uid(), 'draft_schedule', 'post_drafts', _draft_id,
          jsonb_build_object('when', _when));
end;
$$;

-- Comment moderation on the business's posts (delete only, logged).
create or replace function public.team_delete_comment(_business uuid, _comment_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.has_team_role(_business, array['admin','editor','moderator']) then
    raise exception 'not authorised';
  end if;
  if not exists (select 1 from public.comments c
                 join public.posts p on p.id = c.post_id
                 where c.id = _comment_id and p.user_id = _business) then
    raise exception 'not authorised';
  end if;
  update public.comments set held = true where id = _comment_id;
  insert into public.ads_activity_log (business_id, actor_id, action, entity, entity_id)
  values (_business, auth.uid(), 'comment_hide', 'comments', _comment_id);
end;
$$;

-- Notification type for invites.
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'new_follower','follow_request','follow_accepted',
    'comment','reply','comment_reaction','reach_milestone','moderation',
    'message','mention','like','report_update',
    'partnership_request','partnership_update',
    'schedule_update','collab_invite','collab_update','team_invite'));

-- Grants.
revoke all on function public.has_team_role(uuid, text[]) from public, anon, authenticated;
revoke all on function public.invite_team_member(uuid, text, text) from public, anon, authenticated;
revoke all on function public.respond_team_invite(uuid, boolean) from public, anon, authenticated;
revoke all on function public.remove_team_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.tg_ads_activity() from public, anon, authenticated;
revoke all on function public.send_message_as_business(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.get_business_conversations(uuid) from public, anon, authenticated;
revoke all on function public.save_business_draft(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.schedule_business_draft(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.team_delete_comment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.has_team_role(uuid, text[]) to authenticated;
grant execute on function public.invite_team_member(uuid, text, text) to authenticated;
grant execute on function public.respond_team_invite(uuid, boolean) to authenticated;
grant execute on function public.remove_team_member(uuid, uuid) to authenticated;
grant execute on function public.send_message_as_business(uuid, uuid, text) to authenticated;
grant execute on function public.get_business_conversations(uuid) to authenticated;
grant execute on function public.save_business_draft(uuid, jsonb, text) to authenticated;
grant execute on function public.schedule_business_draft(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.team_delete_comment(uuid, uuid) to authenticated;
