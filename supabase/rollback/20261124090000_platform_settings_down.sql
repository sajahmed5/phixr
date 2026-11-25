-- Rollback for 20261124090000_platform_settings.
-- Restores points_for_reason to its previous definition (20260808130000),
-- then removes the settings functions, triggers and tables.

set search_path = public, extensions;

-- 1. points_for_reason back to the hard-coded 20260808130000 version.
create or replace function public.points_for_reason(_reason text)
returns integer language sql immutable set search_path = '' as $fn$
  select case _reason
    when 'swipe'            then 1
    when 'comment'          then 5
    when 'comment_reply'    then 5
    when 'comment_reaction' then 2
    when 'share'            then 3
    when 'message_new'      then 2
    when 'active_day'       then 5
    else null
  end;
$fn$;
revoke all on function public.points_for_reason(text) from public, anon;
grant execute on function public.points_for_reason(text) to authenticated, service_role;

-- 2. Functions (effective depends on tier; both depend on setting_numeric).
drop function if exists public.effective_numeric_setting(uuid, text);
drop function if exists public.user_engagement_tier(uuid);
drop function if exists public.get_client_settings();
drop function if exists public.setting_numeric(text, numeric);

-- 3. Triggers + capture/guard functions.
drop trigger if exists tg_platform_setting_overrides_log on public.platform_setting_overrides;
drop trigger if exists tg_platform_settings_log on public.platform_settings;
drop trigger if exists tg_platform_settings_history_immutable on public.platform_settings_history;
drop function if exists public.tg_platform_settings_log();
drop function if exists public.platform_settings_history_immutable();

-- 4. Tables (children first).
drop table if exists public.platform_setting_overrides;
drop table if exists public.platform_settings_history;
drop table if exists public.platform_settings;
