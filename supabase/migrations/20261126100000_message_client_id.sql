-- Offline outbox: duplicate-proof message sending.
--
-- The app now queues messages written without a connection and sends them once the
-- signal returns. A retry after a lost response must never deliver the same message
-- twice, so each queued message carries a client-generated id (`client_id`). Sending the
-- same (sender, client_id) again returns the existing message instead of inserting.
--
-- Both send functions gain an optional trailing `_client_id uuid default null`, so every
-- existing caller (older app builds) keeps working unchanged.

alter table public.messages add column if not exists client_id uuid;

create unique index if not exists messages_sender_client_id_key
  on public.messages (sender_id, client_id)
  where client_id is not null;

-- send_message v2: same body as before plus the idempotency short-circuit.
drop function if exists public.send_message(uuid, text, text, uuid, uuid);

create function public.send_message(
  _cid uuid,
  _body text default null,
  _media_url text default null,
  _shared_post_id uuid default null,
  _reply_to_id uuid default null,
  _client_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _me uuid := auth.uid(); _mid uuid; _is_group boolean;
  _pending record; _other uuid; _msg_count int;
begin
  if _me is null then raise exception 'unauthorized'; end if;

  -- Already delivered on an earlier attempt: hand back the same message.
  if _client_id is not null then
    select id into _mid from public.messages
      where sender_id = _me and client_id = _client_id;
    if _mid is not null then return _mid; end if;
  end if;

  if not public.is_conversation_member(_cid, _me) then raise exception 'not_a_member'; end if;
  if coalesce(btrim(_body), '') = '' and _media_url is null and _shared_post_id is null then
    raise exception 'empty_message';
  end if;

  select (type = 'group') into _is_group from public.conversations where id = _cid;

  -- Re-check safety against every co-member (covers group + block-after-start).
  if exists (
    select 1 from public.conversation_members m where m.conversation_id = _cid and m.user_id <> _me
      and not public.can_dm(_me, m.user_id)
  ) then raise exception 'not_allowed'; end if;

  -- Request gate (direct only): if a pending request exists and I'm the sender
  -- (i.e. I'm NOT the recipient), I may only send the first message.
  if not _is_group then
    select * into _pending from public.message_requests
      where conversation_id = _cid and status = 'pending' limit 1;
    if _pending.recipient_id is not null and _pending.recipient_id <> _me then
      select count(*) into _msg_count from public.messages where conversation_id = _cid and sender_id = _me;
      if _msg_count >= 1 then raise exception 'request_pending'; end if;
    end if;
  end if;

  begin
    insert into public.messages (conversation_id, sender_id, body, media_url, shared_post_id, reply_to_id, client_id)
      values (_cid, _me, nullif(btrim(_body), ''), _media_url, _shared_post_id, _reply_to_id, _client_id)
      returning id into _mid;
  exception when unique_violation then
    -- Two retries raced; the other one won. Same message, same id.
    select id into _mid from public.messages where sender_id = _me and client_id = _client_id;
    return _mid;
  end;

  update public.conversations set updated_at = now() where id = _cid;
  update public.conversation_members set last_read_at = now() where conversation_id = _cid and user_id = _me;

  -- Notify other members who haven't muted (enqueue_notification handles blocks +
  -- self + throttling). Deep-link payload carries the conversation id.
  perform public.enqueue_notification(m.user_id, 'message', _me, null, null,
            jsonb_build_object('conversation_id', _cid))
  from public.conversation_members m
  where m.conversation_id = _cid and m.user_id <> _me and m.muted = false;
  return _mid;
end $function$;

revoke all on function public.send_message(uuid, text, text, uuid, uuid, uuid) from public, anon;
grant execute on function public.send_message(uuid, text, text, uuid, uuid, uuid) to authenticated, service_role;

-- send_message_as_business v2: dedupe on the business as sender.
drop function if exists public.send_message_as_business(uuid, uuid, text);

create function public.send_message_as_business(
  _business uuid,
  _cid uuid,
  _body text,
  _client_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  _mid uuid;
  _clean text := btrim(_body);
begin
  if not public.has_team_role(_business, array['admin','editor','moderator']) then
    raise exception 'not authorised';
  end if;
  if not exists (select 1 from public.conversation_members m
                 where m.conversation_id = _cid and m.user_id = _business) then
    raise exception 'not authorised';
  end if;

  if _client_id is not null then
    select id into _mid from public.messages
      where sender_id = _business and client_id = _client_id;
    if _mid is not null then return _mid; end if;
  end if;

  if char_length(_clean) = 0 or char_length(_clean) > 2000 then
    raise exception 'bad message';
  end if;

  begin
    insert into public.messages (conversation_id, sender_id, body, client_id)
    values (_cid, _business, _clean, _client_id)
    returning id into _mid;
  exception when unique_violation then
    select id into _mid from public.messages where sender_id = _business and client_id = _client_id;
    return _mid;
  end;

  insert into public.ads_activity_log (business_id, actor_id, action, entity, entity_id)
  values (_business, auth.uid(), 'dm_reply', 'messages', _mid);
  return _mid;
end;
$function$;

revoke all on function public.send_message_as_business(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.send_message_as_business(uuid, uuid, text, uuid) to authenticated, service_role;
