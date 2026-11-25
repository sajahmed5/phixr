-- Part 15: notifications and inbox polish.
--
-- Per-type preferences become tri-state ('on' | 'off' | 'follows') — stored
-- in the existing notification_prefs.prefs jsonb; legacy booleans still mean
-- on/off, so nothing breaks mid-rollout. Enforcement stays SERVER-SIDE in
-- send-push (v11): 'follows' sends only when the recipient follows the actor.
--
-- A daily push cap (setting, DMs/security/moderation exempt) protects users
-- from noisy days — the in-app activity feed still receives everything; only
-- pushes are held.
--
-- Weekly creator digest: Monday-morning summary of the last 7 days, on by
-- default (signed off), off via the 'digest' preference.

insert into public.platform_settings (key, value, description, client_visible) values
  ('push_daily_cap', to_jsonb(15), 'Most pushes per user per day (DMs, security and moderation always deliver).', false),
  ('digest_min_views', to_jsonb(50), 'Views a creator needs in a week before the digest is worth sending.', false)
on conflict (key) do nothing;

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'new_follower','follow_request','follow_accepted',
    'comment','reply','comment_reaction','reach_milestone','moderation',
    'message','mention','like','report_update',
    'partnership_request','partnership_update',
    'schedule_update','collab_invite','collab_update','team_invite',
    'new_login','creator_digest'));

-- Per-user daily push counter. No client access; send-push (service role)
-- bumps it through the definer fn below.
create table public.push_log (
  user_id uuid not null references public.profiles (id) on delete cascade,
  day     date not null,
  n       integer not null default 0,
  primary key (user_id, day)
);
alter table public.push_log enable row level security;
revoke all on table public.push_log from public, anon, authenticated;

create or replace function public._bump_push_count(_uid uuid)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.push_log (user_id, day, n)
  values (_uid, (now() at time zone 'Europe/London')::date, 1)
  on conflict (user_id, day) do update set n = public.push_log.n + 1
  returning n;
$$;

-- ---------------------------------------------------------------------------
-- Weekly creator digest. Plain aggregate numbers about the creator's OWN
-- posts; nothing about who. Skipped below digest_min_views, when the user
-- turned the 'digest' pref off, or if one was already sent this week.
-- ---------------------------------------------------------------------------
create or replace function public.send_creator_digests()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
      -- 'digest' pref: on by default; 'off' / false turns it off.
      and coalesce((select np.prefs->>'digest' from public.notification_prefs np
                    where np.user_id = w.user_id), 'on') not in ('off', 'false')
      -- idempotent: one per week even if the job reruns.
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
$$;

-- Monday mornings (pg_cron runs UTC; 08:30 UTC = 08:30 GMT / 09:30 BST).
select cron.schedule('creator-digest', '30 8 * * 1',
  $$select public.send_creator_digests();$$);

revoke all on function public._bump_push_count(uuid) from public, anon, authenticated;
revoke all on function public.send_creator_digests() from public, anon, authenticated;
