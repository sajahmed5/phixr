-- Rollback for 20261126700000_tag_label_rules.
-- The media pipeline treats a missing table as "no rules" (it falls back to
-- its built-in generic list), so this is safe to run with the new function
-- deployed. Tags already on posts are unaffected.

drop table if exists public.tag_label_rules;
