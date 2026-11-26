-- Rollback for 20261126200000_business_only_features.
-- Restores the pre-split function bodies (no business checks), the open bio-link read
-- policy, and the digest for every account; then drops the helper.

-- ---------------------------------------------------------------------------
-- create_boost (points)
create or replace function public.create_boost(_post_id uuid, _days integer, _age_bands text[] default '{}'::text[], _region_label text default null::text, _tag_ids uuid[] default '{}'::uuid[])
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  _uid uuid := auth.uid();
  _per_day integer := public.setting_numeric('boost_points_per_day', 100)::integer;
  _max_days integer := public.setting_numeric('boost_max_days', 7)::integer;
  _cost integer;
  _balance bigint;
  _id uuid;
begin
  if _uid is null then raise exception 'create_boost: not authenticated'; end if;
  if _days < 1 or _days > _max_days then
    raise exception 'create_boost: days must be between 1 and %', _max_days;
  end if;
  if exists (select 1 from public.profiles pr where pr.id = _uid and pr.age_band = 'minor') then
    raise exception 'create_boost: not available for under-18 accounts';
  end if;
  if not exists (
    select 1 from public.posts p
    where p.id = _post_id and p.user_id = _uid
      and p.visibility = 'public' and p.moderation_status = 'approved'
  ) then
    raise exception 'create_boost: post not eligible';
  end if;
  if exists (select 1 from public.boosts b
             where b.post_id = _post_id and b.status = 'active' and b.ends_at > now()) then
    raise exception 'create_boost: post already boosted';
  end if;
  if exists (select 1 from unnest(_age_bands) ab
             where ab not in ('18-24','25-34','35-44','45-54','55+')) then
    raise exception 'create_boost: bad age band';
  end if;

  _cost := _days * _per_day;
  select points_balance into _balance from public.profiles where id = _uid;
  if _balance < _cost then
    raise exception 'create_boost: not enough points (need %, have %)', _cost, _balance;
  end if;

  insert into public.boosts (post_id, owner_id, age_bands, region_label, tag_ids,
                             ends_at, days, points_cost)
  values (_post_id, _uid, coalesce(_age_bands, '{}'), nullif(btrim(coalesce(_region_label, '')), ''),
          coalesce(_tag_ids, '{}'), now() + make_interval(days => _days), _days, _cost)
  returning id into _id;

  perform public._award_to(_uid, -_cost, 'boost_purchase', 'boost', _id);
  return _id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- create_boost_from_iap (service role, called by the iap-validate edge function).
-- The business check runs BEFORE the receipt is stored, so the purchase is not consumed.
create or replace function public.create_boost_from_iap(_user_id uuid, _post_id uuid, _days integer, _age_bands text[], _region_label text, _tag_ids uuid[], _provider text, _transaction_id text, _product_id text, _amount_pence integer default null::integer, _currency text default null::text, _raw jsonb default '{}'::jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  _max_days integer := public.setting_numeric('boost_max_days', 7)::integer;
  _id uuid;
begin
  if _provider not in ('apple', 'google') then
    raise exception 'create_boost_from_iap: bad provider';
  end if;
  if _days < 1 or _days > _max_days then
    raise exception 'create_boost_from_iap: days must be between 1 and %', _max_days;
  end if;
  if exists (select 1 from public.profiles pr where pr.id = _user_id and pr.age_band = 'minor') then
    raise exception 'create_boost_from_iap: not available for under-18 accounts';
  end if;
  if not exists (
    select 1 from public.posts p
    where p.id = _post_id and p.user_id = _user_id
      and p.visibility = 'public' and p.moderation_status = 'approved'
  ) then
    raise exception 'create_boost_from_iap: post not eligible';
  end if;
  if exists (select 1 from public.boosts b
             where b.post_id = _post_id and b.status = 'active' and b.ends_at > now()) then
    raise exception 'create_boost_from_iap: post already boosted';
  end if;
  if exists (select 1 from unnest(_age_bands) ab
             where ab not in ('18-24','25-34','35-44','45-54','55+')) then
    raise exception 'create_boost_from_iap: bad age band';
  end if;

  begin
    insert into public.iap_receipts (user_id, provider, product_id, transaction_id,
                                     amount_pence, currency, raw)
    values (_user_id, _provider, _product_id, _transaction_id, _amount_pence, _currency, _raw);
  exception when unique_violation then
    raise exception 'create_boost_from_iap: transaction already redeemed';
  end;

  insert into public.boosts (post_id, owner_id, age_bands, region_label, tag_ids,
                             ends_at, days, points_cost, money_pence, provider)
  values (_post_id, _user_id, coalesce(_age_bands, '{}'),
          nullif(btrim(coalesce(_region_label, '')), ''),
          coalesce(_tag_ids, '{}'), now() + make_interval(days => _days), _days,
          0, coalesce(_amount_pence, 0), _provider)
  returning id into _id;

  update public.iap_receipts set boost_id = _id where transaction_id = _transaction_id;
  return _id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- request_payout
create or replace function public.request_payout(_amount_pence integer)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  _enabled boolean := public.setting_numeric('creator_earnings_enabled', 0) >= 1;
  _min     integer := public.setting_numeric('creator_min_payout_pence', 2000)::integer;
  _balance bigint;
  _id      uuid;
begin
  if not _enabled then
    raise exception 'Payouts are not available yet.';
  end if;
  if public.is_minor(auth.uid()) then
    raise exception 'Earnings are for over-18s.';
  end if;
  -- Part 14C: money leaves the account only behind two-step login.
  if not public.mfa_enrolled(auth.uid()) then
    raise exception 'Payouts need two-step login. Turn it on in Settings → Security first.';
  end if;
  if _amount_pence < _min then
    raise exception 'The minimum payout is % pence.', _min;
  end if;
  if not exists (select 1 from public.payout_accounts a
                 where a.user_id = auth.uid() and a.status = 'active') then
    raise exception 'Set up your payout account first.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 9));

  select coalesce((select sum(e.amount_pence) from public.creator_earnings e
                   where e.user_id = auth.uid()), 0)
       - coalesce((select sum(p.amount_pence) from public.creator_payouts p
                   where p.user_id = auth.uid()
                     and p.status in ('requested', 'paid')), 0)
    into _balance;
  if _amount_pence > _balance then
    raise exception 'That is more than your balance.';
  end if;

  insert into public.creator_payouts (user_id, amount_pence)
  values (auth.uid(), _amount_pence)
  returning id into _id;
  return _id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- admin_record_earning (service role): earnings only ever accrue to business accounts.
create or replace function public.admin_record_earning(_user_id uuid, _kind text, _amount_pence integer, _vat_pence integer default 0, _post_id uuid default null::uuid, _note text default null::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  _id uuid;
begin
  if public.is_minor(_user_id) then
    raise exception 'under-18s cannot earn';
  end if;
  if _amount_pence = 0 then
    raise exception 'amount must be non-zero';
  end if;
  insert into public.creator_earnings
    (user_id, kind, amount_pence, vat_pence, post_id, note)
  values (_user_id, _kind, _amount_pence, _vat_pence, _post_id, _note)
  returning id into _id;
  return _id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- declare_partnership: the creator side now needs business too (the brand already did).
create or replace function public.declare_partnership(_post_id uuid, _brand_handle text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  _me    uuid := auth.uid();
  _brand public.profiles;
  _mine  public.profiles;
begin
  if not exists (select 1 from public.posts p
                 where p.id = _post_id and p.user_id = _me) then
    raise exception 'not authorised';
  end if;

  select * into _mine from public.profiles where id = _me;
  if _mine.age_band = 'minor' then
    raise exception 'Paid partnerships are for over-18s.';
  end if;

  select * into _brand from public.profiles
  where lower(handle) = lower(ltrim(btrim(_brand_handle), '@'));
  if not found or _brand.account_type <> 'business' then
    raise exception 'That account is not a business on Phixr.';
  end if;
  if _brand.id = _me then
    raise exception 'You cannot tag yourself.';
  end if;

  begin
    insert into public.post_partnerships (post_id, creator_id, brand_id)
    values (_post_id, _me, _brand.id);
  exception when unique_violation then
    raise exception 'This post already has a partnership declared.';
  end;

  insert into public.notifications (user_id, type, actor_id, post_id, payload)
  values (_brand.id, 'partnership_request', _me, _post_id,
          jsonb_build_object('actor_handle', _mine.handle,
                             'actor_name', _mine.display_name));
end;
$function$;

-- ---------------------------------------------------------------------------
-- schedule_draft
create or replace function public.schedule_draft(_draft_id uuid, _when timestamp with time zone)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
$function$;

-- ---------------------------------------------------------------------------
-- invite_collaborator: inviting co-authors is a business tool (accepting an invite
-- stays open to everyone).
create or replace function public.invite_collaborator(_post_id uuid, _handle text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  _max integer := public.setting_numeric('collab_max_coauthors', 2)::integer;
  _mutual_rule boolean := public.setting_numeric('collab_minor_requires_mutual', 1) >= 1;
  _invitee public.profiles;
  _me public.profiles;
begin
  select * into _me from public.profiles where id = auth.uid();
  if not exists (select 1 from public.posts p
                 where p.id = _post_id and p.user_id = auth.uid()
                   and p.visibility = 'public') then
    raise exception 'Only your own public posts can have co-authors.';
  end if;
  select * into _invitee from public.profiles
  where lower(handle) = lower(ltrim(btrim(_handle), '@'));
  if not found or _invitee.account_status <> 'active' then
    raise exception 'That account cannot be invited.';
  end if;
  if _invitee.id = auth.uid() then raise exception 'You are already the author.'; end if;
  if public.is_blocked_with(_invitee.id) then raise exception 'That account cannot be invited.'; end if;
  if _mutual_rule and (public.is_minor(_invitee.id) <> public.is_minor(auth.uid())) then
    if not (exists (select 1 from public.follows f where f.follower_id = auth.uid()
                      and f.followee_id = _invitee.id and f.status = 'accepted')
        and exists (select 1 from public.follows f where f.follower_id = _invitee.id
                      and f.followee_id = auth.uid() and f.status = 'accepted')) then
      raise exception 'You can only invite people you follow each other with.';
    end if;
  end if;
  if (select count(*) from public.post_collaborators
      where post_id = _post_id and status in ('pending', 'accepted')) >= _max then
    raise exception 'A post can have up to % co-authors.', _max;
  end if;

  insert into public.post_collaborators (post_id, user_id, invited_by)
  values (_post_id, _invitee.id, auth.uid());

  insert into public.notifications (user_id, type, actor_id, post_id, payload)
  values (_invitee.id, 'collab_invite', auth.uid(), _post_id,
          jsonb_build_object('actor_handle', _me.handle, 'actor_name', _me.display_name));
end;
$function$;

-- ---------------------------------------------------------------------------
-- add_profile_link
create or replace function public.add_profile_link(_title text, _url text)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
$function$;

-- Bio links are public only on business profiles. Owners always see their own
-- (policy profile_links_owner), so nothing is lost when switching back and forth.
drop policy if exists profile_links_read on public.profile_links;
create policy profile_links_read on public.profile_links
  for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- send_creator_digests: business accounts only.
create or replace function public.send_creator_digests()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  _min integer := public.setting_numeric('digest_min_views', 50)::integer;
  _sent integer;
begin
  with week as (
    select p.user_id,
           sum(s.views)::bigint as views,
           sum(s.right_swipes)::bigint as likes,
           sum(s.left_swipes)::bigint as skips
    from public.post_daily_stats s
    join public.posts p on p.id = s.post_id
    where s.day >= (now() at time zone 'Europe/London')::date - 7
    group by p.user_id
  ),
  eligible as (
    select w.*,
           case when w.likes + w.skips > 0
                then round(100.0 * w.likes / (w.likes + w.skips))
                else null end as like_pct
    from week w
    join public.profiles pr on pr.id = w.user_id and pr.account_status = 'active'
    where w.views >= _min
      and coalesce((select np.prefs->>'digest' from public.notification_prefs np
                    where np.user_id = w.user_id), 'on') not in ('off', 'false')
      and not exists (select 1 from public.notifications n
                      where n.user_id = w.user_id and n.type = 'creator_digest'
                        and n.created_at > now() - interval '6 days')
  )
  insert into public.notifications (user_id, type, payload)
  select user_id, 'creator_digest',
         jsonb_build_object('views', views, 'likes', likes, 'like_pct', like_pct)
  from eligible;
  get diagnostics _sent = row_count;
  return _sent;
end;
$function$;

-- Grants unchanged by create-or-replace; restate them so this file stands alone.
revoke all on function public.create_boost(uuid, integer, text[], text, uuid[]) from public, anon;
grant execute on function public.create_boost(uuid, integer, text[], text, uuid[]) to authenticated, service_role;
revoke all on function public.create_boost_from_iap(uuid, uuid, integer, text[], text, uuid[], text, text, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_boost_from_iap(uuid, uuid, integer, text[], text, uuid[], text, text, text, integer, text, jsonb) to service_role;
revoke all on function public.request_payout(integer) from public, anon;
grant execute on function public.request_payout(integer) to authenticated, service_role;
revoke all on function public.admin_record_earning(uuid, text, integer, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_record_earning(uuid, text, integer, integer, uuid, text) to service_role;
revoke all on function public.declare_partnership(uuid, text) from public, anon;
grant execute on function public.declare_partnership(uuid, text) to authenticated, service_role;
revoke all on function public.schedule_draft(uuid, timestamp with time zone) from public, anon;
grant execute on function public.schedule_draft(uuid, timestamp with time zone) to authenticated, service_role;
revoke all on function public.invite_collaborator(uuid, text) from public, anon;
grant execute on function public.invite_collaborator(uuid, text) to authenticated, service_role;
revoke all on function public.add_profile_link(text, text) from public, anon;
grant execute on function public.add_profile_link(text, text) to authenticated, service_role;
revoke all on function public.send_creator_digests() from public, anon, authenticated;
grant execute on function public.send_creator_digests() to service_role;

drop function if exists public._require_business(uuid, text);
