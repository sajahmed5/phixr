-- Rollback for 20261125460000_team_access.
drop trigger if exists zz_log_campaigns on public.campaigns;
drop trigger if exists zz_log_ad_sets on public.ad_sets;
drop trigger if exists zz_log_ads on public.ads;
drop function if exists public.tg_ads_activity();
drop function if exists public.team_delete_comment(uuid, uuid);
drop function if exists public.schedule_business_draft(uuid, uuid, timestamptz);
drop function if exists public.save_business_draft(uuid, jsonb, text);
drop function if exists public.get_business_conversations(uuid);
drop function if exists public.send_message_as_business(uuid, uuid, text);

-- Restore the Part 8 own-only policies.
drop policy if exists ad_accounts_select on public.ad_accounts;
drop policy if exists ad_accounts_insert on public.ad_accounts;
drop policy if exists ad_accounts_update on public.ad_accounts;
create policy ad_accounts_own on public.ad_accounts
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists campaigns_select on public.campaigns;
drop policy if exists campaigns_write on public.campaigns;
create policy campaigns_own on public.campaigns
  for all to authenticated using (account_id = auth.uid()) with check (account_id = auth.uid());
drop policy if exists ad_sets_select on public.ad_sets;
drop policy if exists ad_sets_write on public.ad_sets;
create policy ad_sets_own on public.ad_sets
  for all to authenticated
  using (exists (select 1 from public.campaigns c where c.id = campaign_id and c.account_id = auth.uid()))
  with check (exists (select 1 from public.campaigns c where c.id = campaign_id and c.account_id = auth.uid()));
drop policy if exists ads_select on public.ads;
drop policy if exists ads_write on public.ads;
create policy ads_own on public.ads
  for all to authenticated
  using (exists (select 1 from public.ad_sets s join public.campaigns c on c.id = s.campaign_id
                 where s.id = ad_set_id and c.account_id = auth.uid()))
  with check (exists (select 1 from public.ad_sets s join public.campaigns c on c.id = s.campaign_id
                 where s.id = ad_set_id and c.account_id = auth.uid()));
drop policy if exists ad_charges_select on public.ad_charges;
create policy ad_charges_own_select on public.ad_charges
  for select to authenticated using (account_id = auth.uid());

-- Restore is_conversation_member (direct membership only).
create or replace function public.is_conversation_member(_cid uuid, _uid uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (select 1 from public.conversation_members m where m.conversation_id = _cid and m.user_id = _uid);
$fn$;

-- get_ad_report reverts to owner-only: re-apply the Part 8 definition from
-- supabase/migrations/20261125330000_ads_serving.sql (kept verbatim there).

drop table if exists public.ads_activity_log;
drop function if exists public.remove_team_member(uuid, uuid);
drop function if exists public.respond_team_invite(uuid, boolean);
drop function if exists public.invite_team_member(uuid, text, text);
drop function if exists public.has_team_role(uuid, text[]);
drop table if exists public.team_members;

alter table public.notifications drop constraint notifications_type_check;
delete from public.notifications where type = 'team_invite';
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'new_follower','follow_request','follow_accepted',
    'comment','reply','comment_reaction','reach_milestone','moderation',
    'message','mention','like','report_update',
    'partnership_request','partnership_update',
    'schedule_update','collab_invite','collab_update'));
