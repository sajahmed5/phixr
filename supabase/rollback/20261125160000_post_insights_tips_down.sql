-- Rollback for 20261125160000_post_insights_tips.
-- Drops the insights RPC, the shared tip evaluator and the tip-rules table
-- (rule rows are seed data; re-applying the migration reseeds them, though
-- admin edits made since are lost).
--
-- NOTE: 20261125170000_creator_overview's get_creator_overview() calls
-- _pick_tip — roll that migration back first.

set search_path = public, extensions;

drop function if exists public.get_post_insights(uuid);
drop function if exists public._pick_tip(numeric, numeric, numeric, text, numeric);
drop table if exists public.analytics_tip_rules;
