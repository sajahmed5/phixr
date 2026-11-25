-- Part 12D/12E: collab posts, pinned comments, hidden words, comment limits,
-- quick replies and DM folders.

insert into public.platform_settings (key, value, description, client_visible) values
  ('collab_max_coauthors', to_jsonb(2), 'How many co-authors a post can have.', true),
  ('collab_minor_requires_mutual', to_jsonb(1), 'An adult can only invite an under-18 to a collab when they already follow each other (1 = on).', false),
  ('comment_pins_max', to_jsonb(3), 'How many comments can be pinned on a post.', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Collab posts (12D). Accepted co-authorship is PUBLIC (names on the
--    post); pending invites are visible only to the two parties.
-- ---------------------------------------------------------------------------
create table public.post_collaborators (
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  invited_by uuid not null references public.profiles (id) on delete cascade,
  status     text not null default 'pending'
             check (status in ('pending', 'accepted', 'declined', 'left')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  primary key (post_id, user_id)
);
create index post_collaborators_user on public.post_collaborators (user_id, status);

alter table public.post_collaborators enable row level security;
revoke all on table public.post_collaborators from public, anon, authenticated;
grant select on table public.post_collaborators to authenticated;
create policy post_collaborators_select on public.post_collaborators
  for select to authenticated
  using (status = 'accepted' or user_id = auth.uid() or invited_by = auth.uid());

create or replace function public.invite_collaborator(_post_id uuid, _handle text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _max integer := public.setting_numeric('collab_max_coauthors', 2)::integer;
  _mutual_rule boolean := public.setting_numeric('collab_minor_requires_mutual', 1) >= 1;
  _invitee public.profiles;
  _me public.profiles;
begin
  select * into _me from public.profiles where id = auth.uid();
  if not exists (select 1 from public.posts p
                 where p.id = _post_id and p.user_id = auth.uid()
                   and p.visibility = 'public') then
    raise exception 'Only your own public posts can have co-authors.';
  end if;
  select * into _invitee from public.profiles
  where lower(handle) = lower(ltrim(btrim(_handle), '@'));
  if not found or _invitee.account_status <> 'active' then
    raise exception 'That account cannot be invited.';
  end if;
  if _invitee.id = auth.uid() then raise exception 'You are already the author.'; end if;
  if public.is_blocked_with(_invitee.id) then raise exception 'That account cannot be invited.'; end if;
  -- 12D: an adult can only invite an under-18 when they already follow each
  -- other (and the same protection the other way round).
  if _mutual_rule and (public.is_minor(_invitee.id) <> public.is_minor(auth.uid())) then
    if not (exists (select 1 from public.follows f where f.follower_id = auth.uid()
                      and f.followee_id = _invitee.id and f.status = 'accepted')
        and exists (select 1 from public.follows f where f.follower_id = _invitee.id
                      and f.followee_id = auth.uid() and f.status = 'accepted')) then
      raise exception 'You can only invite people you follow each other with.';
    end if;
  end if;
  if (select count(*) from public.post_collaborators
      where post_id = _post_id and status in ('pending', 'accepted')) >= _max then
    raise exception 'A post can have up to % co-authors.', _max;
  end if;

  insert into public.post_collaborators (post_id, user_id, invited_by)
  values (_post_id, _invitee.id, auth.uid());

  insert into public.notifications (user_id, type, actor_id, post_id, payload)
  values (_invitee.id, 'collab_invite', auth.uid(), _post_id,
          jsonb_build_object('actor_handle', _me.handle, 'actor_name', _me.display_name));
end;
$$;

create or replace function public.respond_collab(_post_id uuid, _accept boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _row public.post_collaborators;
  _me public.profiles;
begin
  select * into _row from public.post_collaborators
  where post_id = _post_id and user_id = auth.uid() and status = 'pending'
  for update;
  if not found then raise exception 'not authorised'; end if;
  update public.post_collaborators
     set status = case when _accept then 'accepted' else 'declined' end,
         decided_at = now()
   where post_id = _post_id and user_id = auth.uid();
  select * into _me from public.profiles where id = auth.uid();
  insert into public.notifications (user_id, type, actor_id, post_id, payload)
  values (_row.invited_by, 'collab_update', auth.uid(), _post_id,
          jsonb_build_object('accepted', _accept, 'actor_handle', _me.handle));
end;
$$;

create or replace function public.leave_collab(_post_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _row public.post_collaborators;
begin
  select * into _row from public.post_collaborators
  where post_id = _post_id and user_id = auth.uid() and status = 'accepted'
  for update;
  if not found then raise exception 'not authorised'; end if;
  update public.post_collaborators
     set status = 'left', decided_at = now()
   where post_id = _post_id and user_id = auth.uid();
  insert into public.notifications (user_id, type, actor_id, post_id, payload)
  values (_row.invited_by, 'collab_update', auth.uid(), _post_id,
          jsonb_build_object('left', true));
end;
$$;

-- Shared analytics (12D): accepted co-authors see the post's full insights.
create or replace function public.get_post_insights(_post_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.posts p
                 where p.id = _post_id and p.user_id = auth.uid())
     and not exists (select 1 from public.post_collaborators c
                     where c.post_id = _post_id and c.user_id = auth.uid()
                       and c.status = 'accepted') then
    raise exception 'not authorised';
  end if;
  return public._post_insights(_post_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Pinned comments (12E).
-- ---------------------------------------------------------------------------
alter table public.comments add column pinned_at timestamptz;
create index comments_pinned on public.comments (post_id, pinned_at desc)
  where pinned_at is not null;

create or replace function public.pin_comment(_comment_id uuid, _pinned boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _max integer := public.setting_numeric('comment_pins_max', 3)::integer;
  _post uuid;
begin
  select c.post_id into _post
  from public.comments c
  join public.posts p on p.id = c.post_id
  where c.id = _comment_id and p.user_id = auth.uid();
  if _post is null then raise exception 'not authorised'; end if;
  if _pinned and (select count(*) from public.comments
                  where post_id = _post and pinned_at is not null
                    and id <> _comment_id) >= _max then
    raise exception 'You can pin up to % comments.', _max;
  end if;
  update public.comments
     set pinned_at = case when _pinned then now() end
   where id = _comment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Hidden words (12E): a default list (on by default) + the creator's own.
-- ---------------------------------------------------------------------------
create table public.hidden_words_default (
  phrase text primary key check (char_length(btrim(phrase)) between 2 and 60)
);
insert into public.hidden_words_default (phrase) values
  ('kys'), ('kill yourself'), ('slut'), ('whore'), ('fat pig'), ('ugly bitch'),
  ('retard'), ('nobody likes you'), ('go die'), ('neck yourself'),
  ('waste of space'), ('end yourself')
on conflict do nothing;
alter table public.hidden_words_default enable row level security;
revoke all on table public.hidden_words_default from public, anon, authenticated;
grant select on table public.hidden_words_default to authenticated;
create policy hidden_words_default_read on public.hidden_words_default
  for select to authenticated using (true);

create table public.user_hidden_words (
  user_id uuid not null references public.profiles (id) on delete cascade,
  phrase  text not null check (char_length(btrim(phrase)) between 1 and 60),
  created_at timestamptz not null default now(),
  primary key (user_id, phrase)
);
alter table public.user_hidden_words enable row level security;
revoke all on table public.user_hidden_words from public, anon, authenticated;
grant select, insert, delete on table public.user_hidden_words to authenticated;
create policy user_hidden_words_own on public.user_hidden_words
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.profiles add column use_default_hidden_words boolean not null default true;
grant update (use_default_hidden_words) on table public.profiles to authenticated;

-- Account-wide comment limiting (12E), enforced in add_comment below.
alter table public.profiles add column comment_limit text
  check (comment_limit is null or comment_limit in ('followers', 'week_followers'));
grant update (comment_limit) on table public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Quick replies (12E). Points rules unchanged: add_comment's duplicate
--    detection already gives pasted text little or nothing.
-- ---------------------------------------------------------------------------
create table public.quick_replies (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references public.profiles (id) on delete cascade,
  shortcut  text not null check (char_length(btrim(shortcut)) between 1 and 20),
  body      text not null check (char_length(btrim(body)) between 1 and 500),
  position  integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, shortcut)
);
alter table public.quick_replies enable row level security;
revoke all on table public.quick_replies from public, anon, authenticated;
grant select, insert, update, delete on table public.quick_replies to authenticated;
create policy quick_replies_own on public.quick_replies
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 5. DM folders (12E): Primary / General per member; Requests is the
--    existing message_requests flow. Manual moves only (signed off).
-- ---------------------------------------------------------------------------
alter table public.conversation_members add column folder text not null default 'primary'
  check (folder in ('primary', 'general'));

create or replace function public.set_conversation_folder(_cid uuid, _folder text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if _folder not in ('primary', 'general') then raise exception 'bad folder'; end if;
  update public.conversation_members
     set folder = _folder
   where conversation_id = _cid and user_id = auth.uid();
  if not found then raise exception 'not authorised'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. add_comment v4: comment limits + hidden-word holds (quality logic from
--    Part 5 byte-identical otherwise).
-- ---------------------------------------------------------------------------
create or replace function public.add_comment(_post_id uuid, _body text, _parent_id uuid default null)
returns public.comments
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid    uuid := auth.uid();
  _clean  text := btrim(_body);
  _vis    text;
  _owner  uuid;
  _row    public.comments;
  _short_len integer := public.setting_numeric('points_reply_short_len', 20)::integer;
  _long_len  integer := public.setting_numeric('points_reply_long_len', 120)::integer;
  _short_f   numeric := public.setting_numeric('points_reply_short_factor', 0.25);
  _long_f    numeric := public.setting_numeric('points_reply_long_factor', 2);
  _decay     numeric := public.setting_numeric('points_repeat_decay', 0.5);
  _dup_days  integer := public.setting_numeric('points_duplicate_window_days', 7)::integer;
  _factor    numeric := 1;
  _repeats   integer;
begin
  if _uid is null then
    raise exception 'add_comment: not authenticated';
  end if;
  if char_length(_clean) = 0 then
    raise exception 'add_comment: comment is empty';
  end if;
  if char_length(_clean) > 1000 then
    raise exception 'add_comment: comment is too long';
  end if;

  -- The post must be visible to this user (mirrors the posts SELECT policy).
  select p.visibility, p.user_id into _vis, _owner
  from public.posts p
  where p.id = _post_id
    and p.moderation_status <> 'removed'
    and not public.is_blocked_with(p.user_id)
    and (
      p.user_id = _uid
      or (p.visibility = 'public' and p.moderation_status = 'approved')
      or (p.visibility = 'private' and public.is_accepted_follower_of(p.user_id))
      or (p.visibility = 'groups' and public.is_accepted_follower_of(p.user_id)
          and public.viewer_in_post_groups(p.id))
    );
  if _vis is null then
    raise exception 'add_comment: post not available';
  end if;

  -- Part 12E: the post owner's comment limit (account-wide, for pile-ons).
  if _uid <> _owner then
    declare _limit text;
    begin
      select cl.comment_limit into _limit from public.profiles cl where cl.id = _owner;
      if _limit = 'followers' and not public.is_accepted_follower_of(_owner) then
        raise exception 'Comments are limited to followers right now.';
      elsif _limit = 'week_followers' and not exists (
        select 1 from public.follows f
        where f.follower_id = _uid and f.followee_id = _owner
          and f.status = 'accepted' and f.created_at < now() - interval '7 days'
      ) then
        raise exception 'Comments are limited to longer-term followers right now.';
      end if;
    end;
  end if;

  if _parent_id is not null then
    if not exists (
      select 1 from public.comments c
      where c.id = _parent_id and c.post_id = _post_id and c.parent_comment_id is null
    ) then
      raise exception 'add_comment: invalid parent comment';
    end if;
  end if;

  insert into public.comments (post_id, user_id, parent_comment_id, body)
  values (_post_id, _uid, _parent_id, _clean)
  returning * into _row;

  -- Part 12E: the owner's hidden words hold a matching comment (owner-only
  -- visible via the existing held mechanics; the writer still sees their own).
  if _uid <> _owner and (
       exists (select 1 from public.user_hidden_words w
               where w.user_id = _owner
                 and lower(_clean) like '%' || lower(w.phrase) || '%')
       or (coalesce((select pr.use_default_hidden_words from public.profiles pr
                     where pr.id = _owner), true)
           and exists (select 1 from public.hidden_words_default w
                       where lower(_clean) like '%' || lower(w.phrase) || '%'))
  ) then
    update public.comments set held = true where id = _row.id;
    _row.held := true;
  end if;

  -- Quality factor (Part 5A). Never blocks the comment itself.
  if char_length(_clean) < 2 or _vis = 'groups' then
    _factor := 0;  -- too short to score / group posts never feed points (4A)
  else
    -- Copy-paste of your own recent comment text → nothing.
    if exists (
      select 1 from public.comments c
      where c.user_id = _uid and c.id <> _row.id
        and c.created_at > now() - make_interval(days => _dup_days)
        and lower(btrim(c.body)) = lower(_clean)
    ) then
      _factor := 0;
    else
      if char_length(_clean) <= _short_len then
        _factor := _short_f;
      elsif char_length(_clean) >= _long_len then
        _factor := _long_f;
      end if;
      -- Same-author repeat decay: each earlier comment TODAY on this
      -- author's posts halves (by default) this one's award.
      select count(*) into _repeats
      from public.comments c
      join public.posts p2 on p2.id = c.post_id
      where c.user_id = _uid and c.id <> _row.id
        and p2.user_id = _owner
        and c.created_at >= date_trunc('day', now());
      _factor := _factor * power(_decay, least(_repeats, 20));
    end if;
  end if;

  if _factor > 0 then
    perform public.award_points(
      case when _parent_id is null then 'comment' else 'comment_reply' end,
      'comment',
      _row.id,
      _factor
    );
  end if;

  return _row;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
revoke all on function public.invite_collaborator(uuid, text) from public, anon, authenticated;
revoke all on function public.respond_collab(uuid, boolean) from public, anon, authenticated;
revoke all on function public.leave_collab(uuid) from public, anon, authenticated;
revoke all on function public.pin_comment(uuid, boolean) from public, anon, authenticated;
revoke all on function public.set_conversation_folder(uuid, text) from public, anon, authenticated;
grant execute on function public.invite_collaborator(uuid, text) to authenticated;
grant execute on function public.respond_collab(uuid, boolean) to authenticated;
grant execute on function public.leave_collab(uuid) to authenticated;
grant execute on function public.pin_comment(uuid, boolean) to authenticated;
grant execute on function public.set_conversation_folder(uuid, text) to authenticated;
-- add_comment and get_post_insights keep their existing authenticated grants
-- (CREATE OR REPLACE preserves each function's ACL).
