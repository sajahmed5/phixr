-- Rollback for 20261126100000_message_client_id.
-- Restores the pre-outbox send functions verbatim. Queued messages from newer app
-- builds would then send without duplicate protection.

drop function if exists public.send_message(uuid, text, text, uuid, uuid, uuid);

create function public.send_message(
  _cid uuid,
  _body text default null,
  _media_url text default null,
  _shared_post_id uuid default null,
  _reply_to_id uuid default null
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
  if not public.is_conversation_member(_cid, _me) then raise exception 'not_a_member'; end if;
  if coalesce(btrim(_body), '') = '' and _media_url is null and _shared_post_id is null then
    raise exception 'empty_message';
  end if;

  select (type = 'group') into _is_group from public.conversations where id = _cid;

  if exists (
    select 1 from public.conversation_members m where m.conversation_id = _cid and m.user_id <> _me
      and not public.can_dm(_me, m.user_id)
  ) then raise exception 'not_allowed'; end if;

  if not _is_group then
    select * into _pending from public.message_requests
      where conversation_id = _cid and status = 'pending' limit 1;
    if _pending.recipient_id is not null and _pending.recipient_id <> _me then
      select count(*) into _msg_count from public.messages where conversation_id = _cid and sender_id = _me;
      if _msg_count >= 1 then raise exception 'request_pending'; end if;
    end if;
  end if;

  insert into public.messages (conversation_id, sender_id, body, media_url, shared_post_id, reply_to_id)
    values (_cid, _me, nullif(btrim(_body), ''), _media_url, _shared_post_id, _reply_to_id)
    returning id into _mid;

  update public.conversations set updated_at = now() where id = _cid;
  update public.conversation_members set last_read_at = now() where conversation_id = _cid and user_id = _me;

  perform public.enqueue_notification(m.user_id, 'message', _me, null, null,
            jsonb_build_object('conversation_id', _cid))
  from public.conversation_members m
  where m.conversation_id = _cid and m.user_id <> _me and m.muted = false;
  return _mid;
end $function$;

revoke all on function public.send_message(uuid, text, text, uuid, uuid) from public, anon;
grant execute on function public.send_message(uuid, text, text, uuid, uuid) to authenticated, service_role;

drop function if exists public.send_message_as_business(uuid, uuid, text, uuid);

create function public.send_message_as_business(_business uuid, _cid uuid, _body text)
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
  if char_length(_clean) = 0 or char_length(_clean) > 2000 then
    raise exception 'bad message';
  end if;
  insert into public.messages (conversation_id, sender_id, body)
  values (_cid, _business, _clean)
  returning id into _mid;
  insert into public.ads_activity_log (business_id, actor_id, action, entity, entity_id)
  values (_business, auth.uid(), 'dm_reply', 'messages', _mid);
  return _mid;
end;
$function$;

revoke all on function public.send_message_as_business(uuid, uuid, text) from public, anon;
grant execute on function public.send_message_as_business(uuid, uuid, text) to authenticated, service_role;

drop index if exists public.messages_sender_client_id_key;
alter table public.messages drop column if exists client_id;
