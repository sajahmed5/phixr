-- Rollback for 20261125320000_ads_platform.
-- Drops the whole ads platform. Ad posts are DELETED (they are creatives,
-- not user content) so the narrower visibility constraint holds. Roll back
-- 20261125330000 FIRST.

set search_path = public, extensions;

select cron.unschedule('ads-billing')
where exists (select 1 from cron.job where jobname = 'ads-billing');

drop function if exists public.eligible_ads(uuid);
drop function if exists public.run_ads_billing();
drop function if exists public.record_ad_click(uuid);
drop trigger if exists ad_sets_cpl_flag on public.ad_sets;
drop function if exists public.tg_ad_sets_cpl_flag();
drop trigger if exists ad_accounts_adult on public.ad_accounts;
drop function if exists public.tg_ad_accounts_adult();

drop table if exists public.ad_billing_cursor;
drop table if exists public.ad_charges;
drop table if exists public.ad_hides;
drop table if exists public.ad_clicks;
drop table if exists public.ad_impressions;
drop table if exists public.ads;
drop table if exists public.ad_sets;
drop table if exists public.campaigns;
drop table if exists public.ad_accounts;

drop function if exists public.set_ads_consent(text);
alter table public.profiles drop column if exists ads_consent,
                            drop column if exists ads_consent_at;

delete from public.posts where visibility = 'ad';
alter table public.posts drop constraint posts_visibility_check;
alter table public.posts add constraint posts_visibility_check
  check (visibility in ('public', 'private', 'groups'));

drop policy posts_select on public.posts;
create policy posts_select on public.posts
  for select to authenticated
  using (
    user_id = auth.uid()
    or (
      not public.is_blocked_with(user_id)
      and moderation_status <> 'removed'
      and (not sensitive or not public.is_minor(auth.uid()))
      and (
        (visibility = 'public' and moderation_status = 'approved')
        or (visibility = 'private' and public.is_accepted_follower_of(user_id))
        or (visibility = 'groups'
            and public.is_accepted_follower_of(user_id)
            and public.viewer_in_post_groups(id))
      )
    )
  );

delete from public.platform_settings where key in (
  'ad_cpm_pence', 'ad_cpc_pence', 'ad_cpl_pence',
  'ads_pay_per_like_enabled', 'ad_frequency_cap_daily');
