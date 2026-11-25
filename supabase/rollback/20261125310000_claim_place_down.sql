-- Rollback for 20261125310000_claim_place.
set search_path = public, extensions;
drop function if exists public.claim_place(text, text, text, text, double precision, double precision, text);
