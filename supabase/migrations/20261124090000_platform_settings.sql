-- ============================================================================
-- 20261124090000_platform_settings  (Build brief Part 1A)
--
-- Every tunable number in the product lives here from now on — no hard-coded
-- tuning values in functions or clients. Three tables:
--
--   platform_settings          global key → jsonb value, with a client_visible
--                              flag (bot-detection thresholds must never be
--                              readable by the app, or farmers calibrate)
--   platform_setting_overrides per-user manual overrides (admin-managed)
--   platform_settings_history  append-only change log (who, what, when) for
--                              both tables, filled by trigger
--
-- Reads:
--   setting_numeric(key, default)        internal helper for server functions
--   get_client_settings()                the ONLY client read path: visible keys
--   user_engagement_tier(user)           light / medium / heavy from 7-day swipes
--   effective_numeric_setting(user, key) override → global + engagement delta
--
-- Writes: fame-admin only (service role). App roles get no table access at all
-- (RLS on + zero policies + revoked grants, like every admin table).
--
-- Also rewires points_for_reason to read its values from settings (previously
-- hard-coded), keeping the existing defaults as fallbacks. It becomes SECURITY
-- DEFINER so clients that may call it directly don't need rights on
-- setting_numeric, and STABLE (it reads a table now, so it can't be IMMUTABLE).
-- ============================================================================

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.platform_settings (
  key            text primary key,
  value          jsonb not null,
  description    text not null,
  client_visible boolean not null default false,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users (id),
  constraint platform_settings_key_format check (key ~ '^[a-z0-9_]{1,80}$')
);
comment on table public.platform_settings is
  'Global tunables. Edited only from fame-admin (service role). client_visible=false keys (e.g. bot thresholds) must never reach the app.';
alter table public.platform_settings enable row level security;
revoke all on public.platform_settings from anon, authenticated;

create table public.platform_setting_overrides (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  key        text not null references public.platform_settings (key) on delete cascade,
  value      jsonb not null,
  note       text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),
  primary key (user_id, key)
);
comment on table public.platform_setting_overrides is
  'Per-user manual overrides (admin-managed). Beats the global value and any engagement adjustment in effective_numeric_setting.';
alter table public.platform_setting_overrides enable row level security;
revoke all on public.platform_setting_overrides from anon, authenticated;

create table public.platform_settings_history (
  id         uuid primary key default gen_random_uuid(),
  key        text not null,
  user_id    uuid,                 -- null = global setting; set = per-user override
  old_value  jsonb,                -- null on create
  new_value  jsonb,                -- null on delete
  changed_by uuid,                 -- auth.users id of the admin (null = migration/system)
  changed_at timestamptz not null default now()
);
create index platform_settings_history_key on public.platform_settings_history (key, changed_at desc);
alter table public.platform_settings_history enable row level security;
revoke all on public.platform_settings_history from anon, authenticated;

-- History is append-only, even against the service role (triggers outrank RLS bypass).
create or replace function public.platform_settings_history_immutable()
returns trigger language plpgsql as $fn$
begin
  raise exception 'platform_settings_history is append-only (% attempted)', tg_op;
end;
$fn$;
drop trigger if exists tg_platform_settings_history_immutable on public.platform_settings_history;
create trigger tg_platform_settings_history_immutable
  before update or delete on public.platform_settings_history
  for each row execute function public.platform_settings_history_immutable();

-- ---------------------------------------------------------------------------
-- 2. Change capture on both tables (insert / update / delete)
-- ---------------------------------------------------------------------------
-- One trigger function serves both tables: rows are read through to_jsonb so
-- the absent user_id column on platform_settings simply reads as null.
create or replace function public.tg_platform_settings_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _old jsonb;
  _new jsonb;
begin
  if tg_op <> 'INSERT' then _old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then _new := to_jsonb(new); end if;
  insert into public.platform_settings_history (key, user_id, old_value, new_value, changed_by)
  values (
    coalesce(_new ->> 'key', _old ->> 'key'),
    coalesce(_new ->> 'user_id', _old ->> 'user_id')::uuid,
    _old -> 'value',
    _new -> 'value',
    coalesce(_new ->> 'updated_by', _old ->> 'updated_by')::uuid
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$fn$;

drop trigger if exists tg_platform_settings_log on public.platform_settings;
create trigger tg_platform_settings_log
  after insert or update or delete on public.platform_settings
  for each row execute function public.tg_platform_settings_log();

drop trigger if exists tg_platform_setting_overrides_log on public.platform_setting_overrides;
create trigger tg_platform_setting_overrides_log
  after insert or update or delete on public.platform_setting_overrides
  for each row execute function public.tg_platform_settings_log();

-- ---------------------------------------------------------------------------
-- 3. Read functions
-- ---------------------------------------------------------------------------

-- Internal numeric lookup with a fallback. NOT client-callable: it would leak
-- the non-visible keys (bot thresholds). Server functions are SECURITY DEFINER
-- so they reach it as the owner regardless of caller grants.
create or replace function public.setting_numeric(_key text, _default numeric)
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    (select (ps.value #>> '{}')::numeric
     from public.platform_settings ps
     where ps.key = _key
       and jsonb_typeof(ps.value) = 'number'),
    _default
  );
$fn$;
revoke all on function public.setting_numeric(text, numeric) from public, anon, authenticated;
grant execute on function public.setting_numeric(text, numeric) to service_role;

-- The app's one read path: every client_visible setting as a single object.
-- The client caches this with a TTL (lib/settings.ts) — one call per launch-ish.
create or replace function public.get_client_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(jsonb_object_agg(ps.key, ps.value), '{}'::jsonb)
  from public.platform_settings ps
  where ps.client_visible;
$fn$;
revoke all on function public.get_client_settings() from public, anon, authenticated;
grant execute on function public.get_client_settings() to authenticated;

-- Engagement tier from 7-day swipe volume; thresholds are themselves settings.
create or replace function public.user_engagement_tier(_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select case
    when t.c >= public.setting_numeric('engagement_heavy_swipes_7d', 500) then 'heavy'
    when t.c <  public.setting_numeric('engagement_light_swipes_7d', 50)  then 'light'
    else 'medium'
  end
  from (
    select count(*) as c
    from public.swipes s
    where s.user_id = _user_id and s.created_at >= now() - interval '7 days'
  ) t;
$fn$;
revoke all on function public.user_engagement_tier(uuid) from public, anon, authenticated;
grant execute on function public.user_engagement_tier(uuid) to service_role;

-- Effective value for a user: manual override wins; otherwise the global value
-- plus an engagement-tier delta, when a '<key>_heavy_delta' / '<key>_light_delta'
-- setting exists (e.g. heavier users get slightly more frequent ads). Returns
-- null for unknown keys so callers can tell "no such setting" from a real 0.
create or replace function public.effective_numeric_setting(_user_id uuid, _key text)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  _override numeric;
  _global   numeric;
  _tier     text;
  _delta    numeric := 0;
begin
  select (o.value #>> '{}')::numeric into _override
  from public.platform_setting_overrides o
  where o.user_id = _user_id and o.key = _key and jsonb_typeof(o.value) = 'number';
  if _override is not null then
    return _override;
  end if;

  select (ps.value #>> '{}')::numeric into _global
  from public.platform_settings ps
  where ps.key = _key and jsonb_typeof(ps.value) = 'number';
  if _global is null then
    return null;
  end if;

  _tier := public.user_engagement_tier(_user_id);
  if _tier <> 'medium' then
    _delta := public.setting_numeric(_key || '_' || _tier || '_delta', 0);
  end if;
  return _global + _delta;
end;
$fn$;
revoke all on function public.effective_numeric_setting(uuid, text) from public, anon, authenticated;
grant execute on function public.effective_numeric_setting(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Seeds — every tunable named in the build brief. Values are jsonb numbers.
-- ---------------------------------------------------------------------------
insert into public.platform_settings (key, value, description, client_visible) values
  -- Ads in the deck (Part 2D; slots stay empty until Part 8)
  ('ad_frequency_min',             '15'::jsonb, 'One ad every N–M deck cards: minimum N.', false),
  ('ad_frequency_max',             '20'::jsonb, 'One ad every N–M deck cards: maximum M.', false),
  ('ad_frequency_min_heavy_delta', '-2'::jsonb, 'Added to ad_frequency_min for heavy users (negative = ads slightly more often).', false),
  ('ad_frequency_max_heavy_delta', '-2'::jsonb, 'Added to ad_frequency_max for heavy users.', false),
  ('ad_frequency_min_light_delta', '3'::jsonb,  'Added to ad_frequency_min for light users (positive = ads less often).', false),
  ('ad_frequency_max_light_delta', '3'::jsonb,  'Added to ad_frequency_max for light users.', false),
  -- Explore share (Part 2C): 1 card in N from outside the viewer''s top interests
  ('explore_share_one_in',         '8'::jsonb,  'Explore slice: roughly 1 deck card in N comes from outside the viewer''s top interests (brief range 7–10).', false),
  -- Aggregate privacy floor (absolute rule)
  ('min_aggregate_group_size',     '50'::jsonb, 'Smallest audience group ever shown in any aggregate/advertiser breakdown; smaller groups merge into "Other" or are hidden.', false),
  -- Engagement tiers feeding effective_numeric_setting
  ('engagement_heavy_swipes_7d',   '500'::jsonb, 'Swipes in the last 7 days at or above which a user counts as heavy.', false),
  ('engagement_light_swipes_7d',   '50'::jsonb,  'Swipes in the last 7 days below which a user counts as light.', false),
  -- Bot / fake-engagement detection (Part 1C) — never client_visible
  ('bot_min_watch_ms',             '400'::jsonb, 'A swiped card seen for less than this many ms counts as a fast swipe. One fast swipe never flags anyone; only runs do.', false),
  ('bot_fast_run_len',             '10'::jsonb,  'Flag when this many consecutive swiped cards were all under bot_min_watch_ms.', false),
  ('bot_regular_run_len',          '20'::jsonb,  'Window length for the regular-timing check.', false),
  ('bot_regular_cv',               '0.12'::jsonb,'Coefficient of variation (stddev/mean of inter-card gaps) below which a full window of swipes counts as machine-regular.', false),
  ('bot_monotone_run_len',         '50'::jsonb,  'Flag when this many consecutive swipes were all the same direction.', false),
  ('trust_flag_penalty',           '1'::jsonb,   'Trust-score points lost per newly flagged view event (score starts at 100).', false),
  ('trust_review_threshold',       '40'::jsonb,  'Trust score below which the account joins the fame-admin review queue and stops earning points.', false),
  ('trust_daily_recovery',         '5'::jsonb,   'Trust-score points recovered per day without a new flag.', false),
  -- View events (Part 1B)
  ('view_event_retention_days',    '90'::jsonb,  'Raw post_view_events older than this are purged daily (roll-ups arrive in Part 3).', false),
  ('view_event_batch_size',        '10'::jsonb,  'Client flushes its view-event buffer when it reaches this many events.', true),
  ('view_event_flush_ms',          '15000'::jsonb, 'Client flushes its view-event buffer at least this often while viewing.', true),
  -- Clickbait / quality weights (consumed in Part 2B; seeded now per Part 1A)
  ('quick_skip_ms',                '2000'::jsonb, 'A skip after less than this many ms is a quick skip; after more, a considered skip.', false),
  ('quality_fast_skip_weight',     '1'::jsonb,   'Weight of the fast-skip rate in the post quality signal (Part 2B).', false),
  ('quality_completion_weight',    '1'::jsonb,   'Weight of video completion rate in the post quality signal (Part 2B).', false),
  ('creator_fast_skip_penalty_max','0.5'::jsonb, 'Ceiling of the decaying creator repeat-pattern penalty (Part 2B).', false),
  ('creator_penalty_halflife_days','7'::jsonb,   'Half-life of the creator repeat-pattern penalty so reach recovers when content improves (Part 2B).', false),
  -- Points values (Part 5 extends these; points_for_reason reads them now)
  ('points_value_swipe',           '1'::jsonb,  'Points for a genuine deck swipe (left or right, deliberately equal).', false),
  ('points_value_comment',         '5'::jsonb,  'Points for commenting on a post.', false),
  ('points_value_comment_reply',   '5'::jsonb,  'Points for replying to a comment.', false),
  ('points_value_comment_reaction','2'::jsonb,  'Points for reacting to a comment.', false),
  ('points_value_share',           '3'::jsonb,  'Points for sharing a post.', false),
  ('points_value_message_new',     '2'::jsonb,  'Points for starting a new conversation.', false),
  ('points_value_active_day',      '5'::jsonb,  'Points for the first real action of the day.', false),
  ('points_swipe_min_gap_ms',      '1000'::jsonb, 'Minimum gap since the user''s previous swipe for a swipe to earn points (the record_swipe dwell gate).', false),
  -- Sponsored search (Part 7D)
  ('max_sponsored_search_results', '2'::jsonb,  'Maximum sponsored results per search, always labelled, always showing real distance.', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 5. points_for_reason now reads settings (rule 5: no hard-coded tuning
-- numbers). Falls back to the previous hard-coded values if a key is missing.
-- ---------------------------------------------------------------------------
create or replace function public.points_for_reason(_reason text)
returns integer
language sql
stable
security definer
set search_path = ''
as $fn$
  select case _reason
    when 'swipe'            then public.setting_numeric('points_value_swipe', 1)::integer
    when 'comment'          then public.setting_numeric('points_value_comment', 5)::integer
    when 'comment_reply'    then public.setting_numeric('points_value_comment_reply', 5)::integer
    when 'comment_reaction' then public.setting_numeric('points_value_comment_reaction', 2)::integer
    when 'share'            then public.setting_numeric('points_value_share', 3)::integer
    when 'message_new'      then public.setting_numeric('points_value_message_new', 2)::integer
    when 'active_day'       then public.setting_numeric('points_value_active_day', 5)::integer
    else null
  end;
$fn$;
-- Privileges survive CREATE OR REPLACE, but re-assert them: the recurring
-- default-privileges trap means every migration verifies its own grants.
revoke all on function public.points_for_reason(text) from public, anon;
grant execute on function public.points_for_reason(text) to authenticated, service_role;
