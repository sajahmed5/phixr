-- Part 14D: wellbeing — daily time reminders, quiet mode (notification
-- muting + DM auto-reply), take-a-break, and hide-like-counts options.
-- Preferences live in their own table (own-rows RLS) so the staged profiles
-- column-privacy migration is untouched.

insert into public.platform_settings (key, value, description, client_visible) values
  ('teen_time_reminder_minutes', to_jsonb(45), 'Default daily time reminder for under-18s, in minutes (0 turns it off).', true),
  ('take_break_minutes', to_jsonb(30), 'Continuous swiping minutes before the take-a-break prompt.', true),
  ('quiet_auto_reply_max_len', to_jsonb(200), 'Longest allowed quiet-mode auto-reply.', false)
on conflict (key) do nothing;

create table public.user_wellbeing (
  user_id                uuid primary key references public.profiles (id) on delete cascade,
  -- minutes-of-day, Europe/London (UK-first app); window may cross midnight
  quiet_start_min        smallint check (quiet_start_min between 0 and 1439),
  quiet_end_min          smallint check (quiet_end_min between 0 and 1439),
  quiet_auto_reply       text check (quiet_auto_reply is null or char_length(quiet_auto_reply) <= 200),
  time_reminder_minutes  integer check (time_reminder_minutes is null or time_reminder_minutes between 5 and 480),
  hide_like_counts_others boolean not null default false,
  hide_like_counts_mine   boolean not null default false,
  updated_at             timestamptz not null default now()
);
alter table public.user_wellbeing enable row level security;
revoke all on table public.user_wellbeing from public, anon, authenticated;
grant select, insert, update on table public.user_wellbeing to authenticated;
create policy user_wellbeing_own on public.user_wellbeing
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Is this user in their quiet window right now? (London clock.)
create or replace function public._in_quiet_hours(_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
             when w.quiet_start_min is null or w.quiet_end_min is null then false
             when w.quiet_start_min = w.quiet_end_min then false
             when w.quiet_start_min < w.quiet_end_min
               then m.now_min >= w.quiet_start_min and m.now_min < w.quiet_end_min
             else m.now_min >= w.quiet_start_min or m.now_min < w.quiet_end_min
           end
    from public.user_wellbeing w,
         lateral (select (extract(hour from (now() at time zone 'Europe/London')) * 60
                        + extract(minute from (now() at time zone 'Europe/London')))::integer as now_min) m
    where w.user_id = _uid
  ), false);
$$;

-- Quiet-mode DM auto-reply: when a direct message arrives for someone in
-- their quiet window with an auto-reply set, answer once per conversation
-- per 12 hours. Auto-replies are flagged so they never answer each other.
alter table public.messages add column auto boolean not null default false;

create or replace function public.tg_quiet_auto_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _recipient uuid;
  _reply text;
begin
  if new.auto or new.body is null then return new; end if;
  select m.user_id into _recipient
  from public.conversation_members m
  join public.conversations c on c.id = m.conversation_id and c.type = 'direct'
  where m.conversation_id = new.conversation_id and m.user_id <> new.sender_id
  limit 1;
  if _recipient is null then return new; end if;

  select w.quiet_auto_reply into _reply
  from public.user_wellbeing w
  where w.user_id = _recipient
    and w.quiet_auto_reply is not null
    and public._in_quiet_hours(_recipient);
  if _reply is null then return new; end if;

  if exists (select 1 from public.messages m2
             where m2.conversation_id = new.conversation_id
               and m2.sender_id = _recipient and m2.auto
               and m2.created_at > now() - interval '12 hours') then
    return new;
  end if;

  insert into public.messages (conversation_id, sender_id, body, auto)
  values (new.conversation_id, _recipient, left('Auto-reply: ' || _reply, 2000), true);
  return new;
end;
$$;
create trigger zz_quiet_auto_reply after insert on public.messages
  for each row execute function public.tg_quiet_auto_reply();

revoke all on function public._in_quiet_hours(uuid) from public, anon, authenticated;
revoke all on function public.tg_quiet_auto_reply() from public, anon, authenticated;
