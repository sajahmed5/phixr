-- Part 9A/9B/9C: paid partnerships — disclosure label, brand approval, brand
-- stats, and the promotional-post prompt's data.
--
-- DESIGN (signed off):
--   * ASA/CAP disclosure comes FIRST: the "Paid partnership" label shows the
--     moment the creator declares it. The brand's NAME attaches only once the
--     brand approves (no naming without consent). A brand can later revoke its
--     name; the plain label stays. The creator can never remove the label —
--     only delete the post. Clients get NO direct writes to the table.
--   * Brands are Part 7 business accounts (18+, server-enforced).
--   * Brand identity before approval must not leak: the public surface is
--     get_post_partnerships (labels only, name only when approved). The raw
--     table is readable only by the two parties.
--   * Brand stats reuse Part 3's insights engine: the body moves to an
--     internal _post_insights(); get_post_insights keeps its owner gate and
--     get_partner_post_stats gates on an approved partnership, with the
--     under-18 count stripped (Part 8E rule: minors never in brand data).
--   * Part 9's "mentions a brand and looks promotional" prompt is client-side,
--     fed by business_handles() (which @mentions are businesses — public
--     badge info) and promo_hint_terms (editable nudge patterns; a nudge, not
--     moderation, so client-readable).

-- ---------------------------------------------------------------------------
-- 1. The partnership declarations.
-- ---------------------------------------------------------------------------
create table public.post_partnerships (
  post_id    uuid primary key references public.posts (id) on delete cascade,
  creator_id uuid not null references public.profiles (id) on delete cascade,
  brand_id   uuid not null references public.profiles (id) on delete cascade,
  status     text not null default 'pending'
             check (status in ('pending', 'approved', 'declined', 'revoked')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint partnership_not_self check (creator_id <> brand_id)
);
create index post_partnerships_brand on public.post_partnerships (brand_id, status);

alter table public.post_partnerships enable row level security;
revoke all on table public.post_partnerships from public, anon, authenticated;
grant select on table public.post_partnerships to authenticated;

-- The two parties see their own rows (the creator's compose/manage UI and the
-- brand's approval queue). Everyone else goes through get_post_partnerships,
-- which withholds the brand's name until approval. No client INSERT/UPDATE/
-- DELETE policies exist at all: the label is hard to remove by construction.
create policy post_partnerships_select on public.post_partnerships
  for select to authenticated
  using (creator_id = auth.uid() or brand_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. Notification types for the request/response flow.
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'new_follower','follow_request','follow_accepted',
    'comment','reply','comment_reaction','reach_milestone','moderation',
    'message','mention','like','report_update',
    'partnership_request','partnership_update'));

-- ---------------------------------------------------------------------------
-- 3. Declare / respond / revoke.
-- ---------------------------------------------------------------------------
create or replace function public.declare_partnership(_post_id uuid, _brand_handle text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _me    uuid := auth.uid();
  _brand public.profiles;
  _mine  public.profiles;
begin
  if not exists (select 1 from public.posts p
                 where p.id = _post_id and p.user_id = _me) then
    raise exception 'not authorised';
  end if;

  select * into _mine from public.profiles where id = _me;
  if _mine.age_band = 'minor' then
    raise exception 'Paid partnerships are for over-18s.';
  end if;

  select * into _brand from public.profiles
  where lower(handle) = lower(ltrim(btrim(_brand_handle), '@'));
  if not found or _brand.account_type <> 'business' then
    raise exception 'That account is not a business on Phixr.';
  end if;
  if _brand.id = _me then
    raise exception 'You cannot tag yourself.';
  end if;

  begin
    insert into public.post_partnerships (post_id, creator_id, brand_id)
    values (_post_id, _me, _brand.id);
  exception when unique_violation then
    raise exception 'This post already has a partnership declared.';
  end;

  insert into public.notifications (user_id, type, actor_id, post_id, payload)
  values (_brand.id, 'partnership_request', _me, _post_id,
          jsonb_build_object('actor_handle', _mine.handle,
                             'actor_name', _mine.display_name));
end;
$$;

create or replace function public.respond_partnership(_post_id uuid, _accept boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _row   public.post_partnerships;
  _brand public.profiles;
begin
  select * into _row from public.post_partnerships
  where post_id = _post_id and brand_id = auth.uid() and status = 'pending'
  for update;
  if not found then
    raise exception 'not authorised';
  end if;

  update public.post_partnerships
     set status = case when _accept then 'approved' else 'declined' end,
         decided_at = now()
   where post_id = _post_id;

  select * into _brand from public.profiles where id = auth.uid();
  insert into public.notifications (user_id, type, actor_id, post_id, payload)
  values (_row.creator_id, 'partnership_update', _row.brand_id, _post_id,
          jsonb_build_object('accepted', _accept, 'brand_handle', _brand.handle));
end;
$$;

-- The brand withdrawing its name later: the plain disclosure label STAYS on
-- the post (the creator declared it paid); only the brand's name comes off.
create or replace function public.revoke_partnership(_post_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _row public.post_partnerships;
begin
  select * into _row from public.post_partnerships
  where post_id = _post_id and brand_id = auth.uid() and status = 'approved'
  for update;
  if not found then
    raise exception 'not authorised';
  end if;

  update public.post_partnerships
     set status = 'revoked', decided_at = now()
   where post_id = _post_id;

  insert into public.notifications (user_id, type, actor_id, post_id, payload)
  values (_row.creator_id, 'partnership_update', _row.brand_id, _post_id,
          jsonb_build_object('accepted', false, 'revoked', true));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The public label surface (what deck/feed/post pages render).
-- ---------------------------------------------------------------------------
create or replace function public.get_post_partnerships(_post_ids uuid[])
returns table (post_id uuid, label text)
language sql
stable
security definer
set search_path = ''
as $$
  select pp.post_id,
         case when pp.status = 'approved'
              then 'Paid partnership with @' || br.handle
              else 'Paid partnership' end
  from public.post_partnerships pp
  join public.profiles br on br.id = pp.brand_id
  where pp.post_id = any (_post_ids)
    and cardinality(_post_ids) <= 200;
$$;

-- ---------------------------------------------------------------------------
-- 5. Promotional-post prompt data (9C).
-- ---------------------------------------------------------------------------
create table public.promo_hint_terms (
  id         uuid primary key default gen_random_uuid(),
  pattern    text not null,          -- case-insensitive regex, client-applied
  note       text,
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.promo_hint_terms enable row level security;
revoke all on table public.promo_hint_terms from public, anon, authenticated;
-- A UX nudge, not moderation: no harm in clients reading it, and the compose
-- screen needs it. Admin edits via service role (fame-admin).

insert into public.promo_hint_terms (pattern, note) values
  ('(^|\s)#ad(s)?(\s|$)',        'explicit ad hashtag'),
  ('(^|\s)#sponsored(\s|$)',     'sponsored hashtag'),
  ('(^|\s)#gifted(\s|$)',        'gifted hashtag'),
  ('\msponsored\M',              'sponsored mention'),
  ('\mgifted\M',                 'gifted item'),
  ('discount\s+code',            'affiliate-style promo'),
  ('use\s+my\s+code',            'affiliate-style promo'),
  ('\mswipe\s+up\s+to\s+buy\M',  'direct selling');

create or replace function public.get_promo_hints()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select t.pattern from public.promo_hint_terms t where t.active;
$$;

-- Which of these @mentions are business accounts? (The business badge is
-- public, so this discloses nothing new.)
create or replace function public.business_handles(_handles text[])
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select pr.handle from public.profiles pr
  where lower(pr.handle) = any (select lower(h) from unnest(_handles) h)
    and pr.account_type = 'business'
    and cardinality(_handles) <= 20;
$$;

-- ---------------------------------------------------------------------------
-- 6. Brand stats = the Part 3 insights engine behind a partnership gate.
--    The body moves verbatim into _post_insights (no auth check; the one
--    auth.uid() inside — the better-than-last-10 comparison — becomes the
--    post owner, which is identical for the owner path). Wrappers gate it.
-- ---------------------------------------------------------------------------
create or replace function public._post_insights(_post_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  _min_sample integer := public.setting_numeric('analytics_min_sample', 5)::integer;
  _min_views  integer := public.setting_numeric('analytics_min_views_for_insights', 50)::integer;
  _floor      integer := public.setting_numeric('min_aggregate_group_size', 50)::integer;
  p           public.posts;
  _bot_likes  integer := 0;
  _bot_skips  integer := 0;
  _likes      integer;
  _skips      integer;
  _total      integer;
  _like_rate  numeric;
  _better     integer;
  _recent     integer;
  _views          bigint := 0;
  _quick          bigint := 0;
  _dwell_sum      bigint := 0;
  _video_views    bigint := 0;
  _completions    bigint := 0;
  _completion     numeric;
  _quick_rate     numeric;
  _dropoff        jsonb := '[]'::jsonb;
  _drop_sentence_s integer;
  _bands          jsonb := '[]'::jsonb;
  _under18        integer := 0;
  _top_band       text;
  _top_band_share numeric;
  _regions        jsonb := '[]'::jsonb;
  _interests      jsonb := '[]'::jsonb;
  _liker_count    integer := 0;
  _tip            text;
begin
  select * into p from public.posts where id = _post_id;
  if not found then
    raise exception 'not authorised';
  end if;

  -- Headline: bot-cleaned lifetime counters (same basis as get_post_analytics).
  select bc.bot_like_count, bc.bot_skip_count into _bot_likes, _bot_skips
  from public.post_bot_counts bc where bc.post_id = _post_id;
  _likes := greatest(p.like_count - coalesce(_bot_likes, 0), 0);
  _skips := greatest(p.skip_count - coalesce(_bot_skips, 0), 0);
  _total := _likes + _skips;
  _like_rate := case when _total >= _min_sample
                     then _likes::numeric / _total else null end;

  -- "Better than N of the creator's last 10 posts" (rateable earlier posts only).
  select count(*) filter (where _like_rate is not null and prev.rate < _like_rate),
         count(*)
    into _better, _recent
  from (
    select greatest(p2.like_count - coalesce(bc2.bot_like_count, 0), 0)::numeric
           / nullif(greatest(p2.like_count - coalesce(bc2.bot_like_count, 0), 0)
                  + greatest(p2.skip_count - coalesce(bc2.bot_skip_count, 0), 0), 0) as rate
    from public.posts p2
    left join public.post_bot_counts bc2 on bc2.post_id = p2.id
    where p2.user_id = p.user_id
      and p2.id <> _post_id
      and p2.created_at < p.created_at
      and (greatest(p2.like_count - coalesce(bc2.bot_like_count, 0), 0)
         + greatest(p2.skip_count - coalesce(bc2.bot_skip_count, 0), 0)) >= _min_sample
    order by p2.created_at desc
    limit 10
  ) prev
  where prev.rate is not null;

  -- Watch stats + drop-off from the daily roll-ups.
  select coalesce(sum(s.views), 0), coalesce(sum(s.quick_skips), 0),
         coalesce(sum(s.dwell_ms_sum), 0),
         coalesce(sum(s.video_views), 0), coalesce(sum(s.completions), 0)
    into _views, _quick, _dwell_sum, _video_views, _completions
  from public.post_daily_stats s where s.post_id = _post_id;

  _quick_rate := case when _views > 0 then _quick::numeric / _views else null end;
  _completion := case when _video_views > 0
                      then _completions::numeric / _video_views else null end;

  if _video_views > 0 then
    with stops as (
      select (kv.key)::integer as sec, sum((kv.value)::numeric)::bigint as n
      from public.post_daily_stats s,
           lateral jsonb_each_text(s.stop_positions) kv
      where s.post_id = _post_id
      group by 1
    ),
    curve as (
      select st.sec,
             (_video_views - coalesce(
                sum(st.n) over (order by st.sec rows between unbounded preceding
                                and 1 preceding), 0))::bigint as watching_at_start,
             st.n
      from stops st
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'sec', c.sec, 'watching', c.watching_at_start) order by c.sec), '[]'::jsonb),
           (select c2.sec from curve c2 order by c2.n desc, c2.sec limit 1)
      into _dropoff, _drop_sentence_s
    from curve c;
  end if;

  -- Audience: likers only. Left swipes never appear here.
  select count(*) into _liker_count
  from public.swipes sw where sw.post_id = _post_id and sw.direction = 'right';

  if _liker_count > 0 then
    with banded as (
      select case
               when pr.age_band = 'minor' then 'under18'
               when a.age_y is null then 'Other'
               when a.age_y < 25 then '18-24'
               when a.age_y < 35 then '25-34'
               when a.age_y < 45 then '35-44'
               when a.age_y < 55 then '45-54'
               else '55+'
             end as band
      from public.swipes sw
      join public.profiles pr on pr.id = sw.user_id
      cross join lateral (
        select extract(year from age((now() at time zone 'Europe/London')::date,
                                     pr.date_of_birth))::integer as age_y
      ) a
      where sw.post_id = _post_id and sw.direction = 'right'
    ),
    counted as (select b.band, count(*)::integer as n from banded b group by b.band),
    u18 as (select coalesce(sum(c.n), 0)::integer as n from counted c where c.band = 'under18'),
    folded as (
      select case when c.band <> 'under18' and c.n >= _floor then c.band
                  else 'Other' end as band,
             sum(c.n)::integer as n
      from counted c
      where c.band <> 'under18' or c.n < _floor
      group by 1
    ),
    top_band as (
      select c.band, c.n from counted c
      where c.band <> 'under18' and c.band <> 'Other' and c.n >= _floor
      order by c.n desc limit 1
    )
    select case when u.n >= _floor then u.n end,
           coalesce((select jsonb_agg(jsonb_build_object('band', f.band, 'likes', f.n)
                                      order by f.n desc)
                     from folded f), '[]'::jsonb),
           (select t.band from top_band t),
           (select t.n::numeric / _liker_count from top_band t)
      into _under18, _bands, _top_band, _top_band_share
    from u18 u;

    with by_label as (
      select pr.search_center_label as label, count(*)::integer as n
      from public.swipes sw
      join public.profiles pr on pr.id = sw.user_id
      where sw.post_id = _post_id and sw.direction = 'right'
        and pr.age_band <> 'minor'
      group by pr.search_center_label
    ),
    folded as (
      select case when l.label is not null and l.n >= _floor then l.label
                  else 'Other' end as region,
             sum(l.n)::integer as n
      from by_label l
      group by 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('region', f.region, 'likes', f.n)
                              order by f.n desc), '[]'::jsonb)
      into _regions
    from folded f;

    select coalesce(jsonb_agg(jsonb_build_object('tag', g.tag, 'likes', g.n)
                              order by g.n desc), '[]'::jsonb)
      into _interests
    from (
      select t.name as tag, count(distinct sw.user_id)::integer as n
      from public.swipes sw
      join public.profiles pr on pr.id = sw.user_id and pr.age_band <> 'minor'
      join public.user_tags ut on ut.user_id = sw.user_id and ut.weight > 0
      join public.tags t on t.id = ut.tag_id
      where sw.post_id = _post_id and sw.direction = 'right'
      group by t.name
      having count(distinct sw.user_id) >= _floor
      order by count(distinct sw.user_id) desc
      limit 5
    ) g;
  end if;

  _tip := public._pick_tip(_quick_rate, _completion, _like_rate,
                           _top_band, _top_band_share);

  return jsonb_build_object(
    'deck_likes', _likes,
    'deck_skips', _skips,
    'feed_likes', p.feed_like_count,
    'comments', p.comment_count,
    'reach', p.reach_count,
    'like_rate', _like_rate,
    'better_than', case when _like_rate is not null then _better end,
    'recent_count', _recent,
    'sample_suppressed', (_total < _min_sample),
    'min_views', _min_views,
    'enough_views', (_views >= _min_views or _total >= _min_views),
    'watch', jsonb_build_object(
      'views', _views,
      'quick_skip_rate', _quick_rate,
      'avg_dwell_ms', case when _views > 0 then round(_dwell_sum::numeric / _views) end,
      'video_views', _video_views,
      'completion_rate', _completion,
      'dropoff', _dropoff,
      'dropoff_peak_sec', _drop_sentence_s
    ),
    'audience', jsonb_build_object(
      'likers', _liker_count,
      'age_bands', _bands,
      'under18_likes', _under18,
      'regions', _regions,
      'interests', _interests
    ),
    'tip', _tip
  );
end;
$fn$;

-- The owner's screen, unchanged in behaviour.
create or replace function public.get_post_insights(_post_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.posts p
                 where p.id = _post_id and p.user_id = auth.uid()) then
    raise exception 'not authorised';
  end if;
  return public._post_insights(_post_id);
end;
$$;

-- The approved brand's view: same aggregates, with the combined under-18
-- count stripped — a brand never learns anything about minors (8E rule).
create or replace function public.get_partner_post_stats(_post_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.post_partnerships pp
                 where pp.post_id = _post_id and pp.brand_id = auth.uid()
                   and pp.status = 'approved') then
    raise exception 'not authorised';
  end if;
  return public._post_insights(_post_id) #- '{audience,under18_likes}';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants (Supabase default privileges hand EXECUTE to everyone: revoke
--    from all three, then grant exactly what clients call).
-- ---------------------------------------------------------------------------
revoke all on function public.declare_partnership(uuid, text) from public, anon, authenticated;
revoke all on function public.respond_partnership(uuid, boolean) from public, anon, authenticated;
revoke all on function public.revoke_partnership(uuid) from public, anon, authenticated;
revoke all on function public.get_post_partnerships(uuid[]) from public, anon, authenticated;
revoke all on function public.get_promo_hints() from public, anon, authenticated;
revoke all on function public.business_handles(text[]) from public, anon, authenticated;
revoke all on function public._post_insights(uuid) from public, anon, authenticated;
revoke all on function public.get_partner_post_stats(uuid) from public, anon, authenticated;
-- get_post_insights keeps its existing grant (authenticated) from Part 3; the
-- CREATE OR REPLACE preserves the function's ACL.

grant execute on function public.declare_partnership(uuid, text) to authenticated;
grant execute on function public.respond_partnership(uuid, boolean) to authenticated;
grant execute on function public.revoke_partnership(uuid) to authenticated;
grant execute on function public.get_post_partnerships(uuid[]) to authenticated;
grant execute on function public.get_promo_hints() to authenticated;
grant execute on function public.business_handles(text[]) to authenticated;
grant execute on function public.get_partner_post_stats(uuid) to authenticated;
