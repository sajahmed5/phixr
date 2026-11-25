-- Rollback for 20261125550000_wellbeing.
-- DROPS DATA (flagged per Part 0): quiet-mode schedules, auto-reply text,
-- reminder choices and hide-like-counts flags are discarded; the messages
-- auto flag goes too (auto-replies stay as ordinary messages).
-- NOTE: redeploy send-push v9 (or strip its quiet-hours check) first — v10
-- calls _in_quiet_hours.

drop trigger if exists zz_quiet_auto_reply on public.messages;
drop function if exists public.tg_quiet_auto_reply();
drop function if exists public._in_quiet_hours(uuid);
alter table public.messages drop column if exists auto;
drop table if exists public.user_wellbeing;
delete from public.platform_settings where key in
  ('teen_time_reminder_minutes', 'take_break_minutes', 'quiet_auto_reply_max_len');
