-- Rollback for 20261125170000_creator_overview.

set search_path = public, extensions;

drop function if exists public.get_creator_overview();
