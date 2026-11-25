import { Platform, Share } from 'react-native';

import type { DeckCard } from '@/lib/deck';
import { getConversations, type Conversation } from '@/lib/messages';
import { supabase } from '@/lib/supabase';

// Universal-link host for shared posts — the public web page + deep-link target.
const POST_LINK_BASE = 'https://joinphixr.com/post';

export type SharePerson = { id: string; handle: string; display_name: string; avatar_url: string | null };

/** People I follow + my existing conversations, for the in-app share picker. */
export async function getShareTargets(): Promise<{ conversations: Conversation[]; people: SharePerson[] }> {
  const { data: u } = await supabase.auth.getUser();
  const me = u.user?.id;
  const [conversations, followRows] = await Promise.all([
    getConversations(),
    me
      ? supabase.from('follows').select('followee_id').eq('follower_id', me).eq('status', 'accepted')
      : Promise.resolve({ data: [] as { followee_id: string }[] }),
  ]);
  const ids = (followRows.data ?? []).map((r) => r.followee_id);
  let people: SharePerson[] = [];
  if (ids.length) {
    const { data } = await supabase.from('profiles').select('id, handle, display_name, avatar_url').in('id', ids);
    people = (data ?? []) as SharePerson[];
  }
  return { conversations, people };
}

/** Send a post to conversations and/or people, optionally with a message. */
export async function sharePost(
  postId: string,
  opts: { conversationIds?: string[]; recipientIds?: string[]; message?: string },
): Promise<void> {
  const { error } = await supabase.rpc('share_post', {
    _post_id: postId,
    _conversation_ids: opts.conversationIds ?? [],
    _recipient_ids: opts.recipientIds ?? [],
    _message: opts.message?.trim() || null,
  });
  if (error) throw error;
}

export function postLink(postId: string): string {
  return `${POST_LINK_BASE}/${postId}`;
}

/** Part 14E: public profile link (universal link → app, App Store otherwise). */
export function profileLink(handle: string): string {
  return `https://joinphixr.com/u/${encodeURIComponent(handle)}`;
}

/** OS share sheet for a profile. Profiles are public pages — always allowed. */
export async function shareProfile(handle: string, displayName?: string | null): Promise<void> {
  const url = profileLink(handle);
  const text = `${displayName || `@${handle}`} is on Phixr`;
  try {
    if (Platform.OS === 'web') {
      const nav = typeof navigator !== 'undefined' ? navigator : undefined;
      if (nav?.share) await nav.share({ title: 'Phixr', text, url });
      return;
    }
    await Share.share({ message: `${text} ${url}`, url });
  } catch {
    // user dismissed the sheet — not an error
  }
}

/**
 * Part 14E: download YOUR OWN post's media — fetched to cache, then the OS
 * share sheet ("Save Image/Video" included). Caller enforces ownership; the
 * media URL is the already-signed one the screen is displaying.
 */
export async function downloadOwnPostMedia(signedUrl: string, mediaType: 'image' | 'video'): Promise<void> {
  const { File, Paths } = await import('expo-file-system');
  const ext = mediaType === 'video' ? 'mp4' : 'jpg';
  const file = new File(Paths.cache, `phixr-${Date.now()}.${ext}`);
  await File.downloadFileAsync(signedUrl, file);
  await Share.share(
    Platform.OS === 'ios' ? { url: file.uri } : { message: file.uri, url: file.uri },
  );
}

/**
 * Share a post via the native share sheet (a link to the post).
 *
 * V2 EXTENSION POINT — in-app friend sharing: before falling back to the OS sheet,
 * present an in-app friend picker here and, on selection, send the post through the
 * (future) messaging layer instead of / in addition to the native share.
 */
export async function shareCard(card: DeckCard): Promise<void> {
  const url = `${POST_LINK_BASE}/${card.id}`;
  const text = card.caption ? `${card.caption} — on Phixr` : 'Check this out on Phixr';

  try {
    if (Platform.OS === 'web') {
      const nav = typeof navigator !== 'undefined' ? navigator : undefined;
      if (nav?.share) {
        await nav.share({ title: 'Phixr', text, url });
        void recordShare(card.id);
      }
      // else: no web share support — the in-app picker (above) will cover this in V2.
      return;
    }
    const result = await Share.share({ message: `${text} ${url}`, url });
    // Only count an actual share, not a dismissal (aggregate count — no viewer identity).
    if (result.action === Share.sharedAction) void recordShare(card.id);
  } catch {
    // User dismissed the sheet, or share is unavailable — nothing to do.
  }
}

async function recordShare(postId: string): Promise<void> {
  await supabase.rpc('record_share', { _post_id: postId }).then(undefined, () => {});
}
