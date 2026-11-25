-- Rollback for 20261125450000_collab_comments_dm.
drop function if exists public.set_conversation_folder(uuid, text);
alter table public.conversation_members drop column if exists folder;
drop table if exists public.quick_replies;
alter table public.profiles drop column if exists comment_limit;
alter table public.profiles drop column if exists use_default_hidden_words;
drop table if exists public.user_hidden_words;  -- flagged: drops creators' hidden-word lists
drop table if exists public.hidden_words_default;
drop function if exists public.pin_comment(uuid, boolean);
alter table public.comments drop column if exists pinned_at;
drop function if exists public.leave_collab(uuid);
drop function if exists public.respond_collab(uuid, boolean);
drop function if exists public.invite_collaborator(uuid, text);
drop table if exists public.post_collaborators;  -- flagged: drops collab records

-- Restore the owner-only get_post_insights wrapper (Part 9 form).
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

-- Restore add_comment v3 (the 20261125210000 text) verbatim.
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
