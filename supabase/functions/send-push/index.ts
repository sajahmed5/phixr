// ============================================================================
// send-push — Edge Function invoked by the notifications dispatch trigger
// (pg_net) with { notification_id }. It:
//   1. verifies the webhook secret (only the DB trigger may call it),
//   2. loads the notification + recipient,
//   3. RESPECTS the per-category notification preference SERVER-SIDE (a disabled
//      category is never delivered, regardless of the client UI),
//   4. sends an Expo push to each of the recipient's device tokens with the
//      correct deep-link data + badge count,
//   5. cleans up tokens Expo reports as DeviceNotRegistered (revoked tokens).
//
// It never sends anything derived from a swipe — those never create a
// notification in the first place (see the migration; no trigger on swipes).
// ============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

import { reportError, withSentry } from '../_shared/sentry.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// notification type → preference category (Part 15: every type has one).
// 'moderation' and 'new_login' have no toggle — always sent.
const CATEGORY: Record<string, string | null> = {
  like: 'likes',
  comment: 'comments',
  reply: 'comments',
  comment_reaction: 'reactions',
  mention: 'mentions',
  new_follower: 'follows',
  follow_accepted: 'follows',
  follow_request: 'requests',
  reach_milestone: 'reach',
  message: 'messages',
  schedule_update: 'posts',
  collab_invite: 'posts',
  collab_update: 'posts',
  partnership_request: 'business',
  partnership_update: 'business',
  team_invite: 'business',
  creator_digest: 'digest',
  moderation: null,
  new_login: null, // security: always delivered, even in quiet hours
};

// Prefs are tri-state: 'on' | 'off' | 'follows' (legacy true/false = on/off).
type PrefValue = boolean | string | undefined;
function prefMode(v: PrefValue): 'on' | 'off' | 'follows' {
  if (v === false || v === 'off' || v === 'false') return 'off';
  if (v === 'follows') return 'follows';
  return 'on';
}

// Types that NEVER count against (or get held by) the daily push cap.
const CAP_EXEMPT = new Set(['message', 'new_login', 'moderation']);

type Notification = {
  id: string; user_id: string; type: string; actor_id: string | null;
  post_id: string | null; comment_id: string | null; count: number; payload: Record<string, unknown>;
};

Deno.serve(withSentry('send-push', async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });

  // Only the DB dispatch trigger may call this.
  const secret = Deno.env.get('PUSH_WEBHOOK_SECRET') ?? '';
  if (!secret || req.headers.get('x-webhook-secret') !== secret) {
    return new Response('unauthorized', { status: 401 });
  }

  let notificationId: string;
  try {
    notificationId = (await req.json()).notification_id;
    if (!notificationId) throw new Error('missing id');
  } catch {
    return new Response('bad_request', { status: 400 });
  }

  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const { data: notif } = await svc.from('notifications').select('*').eq('id', notificationId).single<Notification>();
  if (!notif) return json({ skipped: 'not_found' });

  // ---- server-side preference enforcement (Part 15: tri-state) ----
  const category = CATEGORY[notif.type];
  if (category) {
    const { data: pref } = await svc.from('notification_prefs').select('prefs').eq('user_id', notif.user_id).maybeSingle();
    const prefs = (pref?.prefs ?? {}) as Record<string, PrefValue>;
    const mode = prefMode(prefs[category]);
    if (mode === 'off') return json({ skipped: 'category_disabled' });
    if (mode === 'follows' && notif.actor_id) {
      const { data: follows } = await svc
        .from('follows')
        .select('followee_id')
        .eq('follower_id', notif.user_id)
        .eq('followee_id', notif.actor_id)
        .eq('status', 'accepted')
        .maybeSingle();
      if (!follows) return json({ skipped: 'not_followed' });
    }
  }

  // Part 14D: quiet mode — routine pushes hold during the user's quiet hours.
  // Security alerts (new_login) always go out.
  if (notif.type !== 'new_login') {
    const { data: quiet } = await svc.rpc('_in_quiet_hours', { _uid: notif.user_id });
    if (quiet === true) return json({ skipped: 'quiet_hours' });
  }

  // ---- daily push cap (Part 15): DMs, security and moderation are exempt;
  // the in-app activity feed still gets everything — only pushes are held ----
  if (!CAP_EXEMPT.has(notif.type)) {
    const { data: capRow } = await svc
      .from('platform_settings')
      .select('value')
      .eq('key', 'push_daily_cap')
      .maybeSingle();
    const cap = Number(capRow?.value ?? 15) || 15;
    const { data: count } = await svc.rpc('_bump_push_count', { _uid: notif.user_id });
    if (typeof count === 'number' && count > cap) return json({ skipped: 'daily_cap' });
  }

  // ---- recipient's device tokens + badge ----
  const { data: tokens } = await svc.from('push_tokens').select('token').eq('user_id', notif.user_id);
  if (!tokens?.length) return json({ skipped: 'no_tokens' });

  // Part 11 (multi-account): which of this user's device tokens are shared
  // with OTHER signed-in accounts? Those pushes get an "@handle:" prefix so
  // the user can tell which account it's for, and the payload carries the
  // account id so a tap switches account first.
  const tokenList = tokens.map((t) => t.token);
  const { data: shared } = await svc
    .from('push_tokens')
    .select('token, user_id')
    .in('token', tokenList);
  const sharedTokens = new Set(
    (shared ?? [])
      .filter((r) => r.user_id !== notif.user_id)
      .map((r) => r.token),
  );
  const { data: me } = await svc.from('profiles').select('handle').eq('id', notif.user_id).maybeSingle();
  const myHandle = me?.handle ?? '';

  const { count: badge } = await svc
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', notif.user_id)
    .is('read_at', null);

  // actor handle for the message body
  let actor = '';
  if (notif.actor_id) {
    const { data: a } = await svc.from('profiles').select('handle').eq('id', notif.actor_id).maybeSingle();
    actor = a?.handle ?? '';
  }
  const { title, body } = compose(notif, actor);

  const messages = tokens.map((t) => ({
    to: t.token,
    // Shared device → say which account this is for ("@saj_creates: …").
    title: sharedTokens.has(t.token) && myHandle ? `@${myHandle}: ${title}` : title,
    body,
    sound: 'default',
    badge: typeof badge === 'number' ? badge : undefined,
    data: {
      type: notif.type, post_id: notif.post_id, comment_id: notif.comment_id, actor,
      notification_id: notif.id, conversation_id: notif.payload?.conversation_id ?? null,
      // Part 11: the account this push belongs to — the tap handler switches
      // to it before navigating.
      account_user_id: notif.user_id,
    },
  }));

  // ---- send via Expo, then reap revoked tokens ----
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(messages),
    });
    const out = await res.json().catch(() => ({}));
    const tickets: { status?: string; details?: { error?: string } }[] = out?.data ?? [];
    const dead: string[] = [];
    tickets.forEach((tk, i) => {
      if (tk?.details?.error === 'DeviceNotRegistered') dead.push(tokens[i].token);
    });
    if (dead.length) await svc.from('push_tokens').delete().in('token', dead);
    return json({ sent: messages.length, pruned: dead.length });
  } catch (e) {
    console.error('[send-push] expo error', e);
    await reportError(e);
    return json({ error: 'send_failed' }, 502);
  }
}));

function compose(n: Notification, actor: string): { title: string; body: string } {
  const at = actor ? `@${actor}` : 'Someone';
  switch (n.type) {
    case 'new_follower': return { title: 'New follower', body: `${at} started following you` };
    case 'follow_request': return { title: 'Follow request', body: `${at} wants to follow you` };
    case 'follow_accepted': return { title: 'Request accepted', body: `${at} accepted your follow request` };
    case 'comment': return { title: 'New comment', body: n.count > 1 ? `${n.count} new comments on your post` : `${at} commented on your post` };
    case 'reply': return { title: 'New reply', body: n.count > 1 ? `${n.count} new replies to your comment` : `${at} replied to your comment` };
    case 'comment_reaction': return { title: 'New reaction', body: `${at} reacted ${n.payload.emoji ?? ''} to your comment` };
    case 'reach_milestone': return { title: 'Your post is taking off 🎉', body: `Your post has reached ${fmt(n.payload.milestone)}+ people` };
    case 'message': return { title: at, body: n.count > 1 ? `${n.count} new messages` : 'Sent you a message' };
    case 'mention': return { title: 'Mentioned you', body: `${at} mentioned you` };
    case 'moderation': return moderationMsg(String(n.payload.status ?? ''));
    case 'new_login': return {
      title: 'New login to your account',
      body: `Your account was just used on a new ${String(n.payload.platform ?? '')} device. Not you? Open Phixr to secure your account.`,
    };
    case 'team_invite': return {
      title: 'Team invite',
      body: `${at} invited you to help run their business (${String(n.payload.role ?? 'team')})`,
    };
    case 'creator_digest': return {
      title: 'Your week on Phixr',
      body: `Your posts got ${fmt(n.payload.views)} views this week${n.payload.like_pct != null ? `, ${n.payload.like_pct}% liked` : ''}. See your dashboard →`,
    };
    default: return { title: 'Phixr', body: 'You have a new notification' };
  }
}

function moderationMsg(status: string): { title: string; body: string } {
  if (status === 'approved') return { title: 'Your post is live', body: 'Your post passed review and is now visible.' };
  if (status === 'flagged') return { title: 'Post under review', body: 'Your post is being reviewed and isn’t visible to others yet.' };
  if (status === 'removed') return { title: 'Post removed', body: 'One of your posts was removed for breaking our guidelines.' };
  return { title: 'Moderation update', body: 'There’s an update on one of your posts.' };
}

function fmt(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : String(v ?? '');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
